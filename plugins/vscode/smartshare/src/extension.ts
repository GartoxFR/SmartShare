import * as vscode from 'vscode';
import { logClient, logServer, offsetToRange } from './utils';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Ack, Cursor, Declare, File, Message, RequestFile, TextModification, Update, isMessage, matchMessage } from './message';

let waitingAcks = 0;
let clientProc: ChildProcessWithoutNullStreams | undefined;
let serverProc: ChildProcessWithoutNullStreams | undefined;
let changeDocumentDisposable: vscode.Disposable;
let changeSelectionsDisposable: vscode.Disposable;
let statusBarItem: vscode.StatusBarItem;
let init = true;
let ignoreNextEvent = false;
let decoration: vscode.TextEditorDecorationType;
let cursorsDecorations: Map<number, vscode.Disposable> = new Map<number, vscode.Disposable>();

const EXE_PATH = __dirname + '/../../../../smartshare/target/debug/';
const DEFAULT_ADDR = "127.0.0.1";
const DEFAULT_PORT = "4903";
const CURSOR_COLORS = ["Salmon", "YellowGreen", "SteelBlue", "MediumOrchid", "DarkOrange", "Aqua"];

function procWrite(proc: ChildProcessWithoutNullStreams, message: Message): void {
    logClient.debug("Send message", JSON.stringify(message));
    proc.stdin.write(JSON.stringify(message) + '\n');
}

function setCursor(clientId: number, range: vscode.Range) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const prevDecoration = cursorsDecorations.get(clientId);
    decoration = vscode.window.createTextEditorDecorationType({
        borderWidth: "0 2px 0 0",
        borderStyle: "solid",
        borderColor: CURSOR_COLORS[clientId % CURSOR_COLORS.length],
        backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
    });
    cursorsDecorations.set(clientId, decoration);
    prevDecoration?.dispose()
    editor.setDecorations(decoration, [range]);
}

async function applyChange(change: TextModification): Promise<boolean> {
    ignoreNextEvent = true;
    return await change.write();
}

function clientStdoutHandler(): (chunk: any) => void {
    let data_line = "";
    return (data) => {
        const lines = data.split("\n");
        for (let line of lines) {
            data_line += line;
            if (data_line.length > 0) {
                logClient.debug("recieved data", data_line);
                const data = JSON.parse(data_line);
                if (!isMessage(data)) {
                    logClient.error("invalid action " + data.action)
                    break;
                }
                handleMessage(data);
            }
            data_line = '';
        }
        data_line = lines[lines.length - 1];
    }
}

function handleMessage(data: Message) {
    const editor = vscode.window.activeTextEditor;
    matchMessage(data)(
        (update: Update) => {
            if (!waitingAcks) {
                for (let change of update.changes) {
                    change = new TextModification(change.offset, change.delete, change.text);
                    applyChange(change).then((success) => {
                        console.log("success ?" + success);
                        if (success && clientProc) {
                            procWrite(clientProc, { action: "ack" })
                        }
                    }).catch(err => console.log("err" + err))
                }
            } else {
                logClient.debug("Ignore update before acknowledge", update)
            }
        },
        (declare: Declare) => {
            logClient.error("Recieved invalid action declare", declare)
        },
        (error: Error) => {
            logClient.error("From client: ", error)
        },
        (_: RequestFile) => {
            if (!clientProc || !vscode.window.activeTextEditor) {
                return;
            }
            vscode.window.showInformationMessage("Created a SmartShare session");
            statusBarItem.text = "Connected";
            procWrite(clientProc, {
                action: "file",
                file: vscode.window.activeTextEditor.document.getText()
            })
            init = false;
        },
        (file: File) => {
            vscode.window.showInformationMessage("Connected to the SmartShare session");
            statusBarItem.text = "Connected";
            ignoreNextEvent = false;
            new TextModification(0, editor?.document.getText().length || 0, file.file).write()
                .then(() => { init = false });
        },
        (_: Ack) => {
            if (!waitingAcks) {
                logClient.info("Recieved unexpected ack");
            } else {
                waitingAcks--;
            }
        },
        (cursor: Cursor) => {
            if (!editor) {
                return;
            }
            setCursor(cursor.id, offsetToRange(editor, cursor.offset, cursor.range));
        }
    );
}

function changeDocumentHandler(event: vscode.TextDocumentChangeEvent): void {

    if (event.document.uri.path.startsWith("extension-output")) {
        return;
    }

    console.log(event.document.uri);

    if (init || !clientProc) {
        return;
    }
    if(ignoreNextEvent) {
        ignoreNextEvent = false
        return;
    }

    let changes = event.contentChanges.map(change => {
        return new TextModification(
            change.rangeOffset,
            change.rangeLength,
            change.text
        )
    });
    let message: Update = {
        action: "update",
        changes: changes
    };
    procWrite(clientProc, message);
    waitingAcks++;
}

function changeSelectionsHandler(event: vscode.TextEditorSelectionChangeEvent): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !clientProc) {
        return;
    }
    const selection = event.selections[0];
    const offset = event.textEditor.document.offsetAt(selection.active);
    const range = event.textEditor.document.offsetAt(selection.anchor) - offset;
    const message: Cursor = {
        id: 0,
        action: "cursor",
        offset: offset,
        range: range,
    }
    procWrite(clientProc, message);
}


function startClient(addr: string) {

    if (clientProc) {
        vscode.window.showInformationMessage("Already connected to a SmartShare session")
        return;
    }

    let client = spawn(
        EXE_PATH + "client",
        [addr + ":" + DEFAULT_PORT],
        { env: { RUST_LOG: 'trace' } }
    );
    clientProc = client;

    client.on('error', () => {
        vscode.window.showErrorMessage("Failed to start the SmartShare client")
    });

    client.on('spawn', () => {
        logClient.info(`Launched client subprocess at pid ${client.pid}`);
        client.stdout.setEncoding("utf8");
        const message: Declare = { action: "declare", offset_format: "chars" };
        procWrite(client, message);

    });
    
    client.stdout.on("data", clientStdoutHandler());
    
    client.stderr.on("data", (data) => {
        logClient.subprocess(data + "");
        console.log(data + "");
    });

    client.on('close', (code: number, signal: string) => {
        client.removeAllListeners();
        changeDocumentDisposable?.dispose();
        changeSelectionsDisposable?.dispose();
        cursorsDecorations.forEach((decoration, _) => {
            decoration.dispose();
        })
        if (signal == "SIGTERM") {
            vscode.window.showInformationMessage("Disconnected from SmartShare session");
        } else {
            vscode.window.showErrorMessage("Disconnected from the SmartShare session");
        }
        statusBarItem.text = "Disconnected";
        clientProc = undefined;
    });

    changeDocumentDisposable = vscode.workspace.onDidChangeTextDocument(changeDocumentHandler);
    changeSelectionsDisposable = vscode.window.onDidChangeTextEditorSelection(changeSelectionsHandler);
}


function startServer(onServerStart: () => void) {
    if (serverProc) {
        vscode.window.showInformationMessage("Already hosting a SmartShare session")
        return;
    }

    const server = spawn(
        EXE_PATH + "server", [],
        { env: { RUST_LOG: 'trace' } }
    );
    serverProc = server;

    server.on('error', () => {
        vscode.window.showErrorMessage("Failed to start the SmartShare server")
    });

    server.on('spawn', () => {
        onServerStart();
    });

    server.stdout.on("data", function (data) {
        logServer.subprocess(data + "");
    });

    server.stderr.on("data", function (data) {
        logServer.subprocess(data + "");
    });

    server.on('close', () => {
        server.removeAllListeners();
        serverProc = undefined;
    });
}


export async function activate(context: vscode.ExtensionContext) {

    statusBarItem = vscode.window.createStatusBarItem("Disconnected", vscode.StatusBarAlignment.Right, 100);
    statusBarItem.show();


    context.subscriptions.push(vscode.commands.registerCommand('smartshare.createSession', () => {
        startServer(() => {
            setTimeout(() => {
                startClient(DEFAULT_ADDR)
            }, 100);
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('smartshare.joinSession', async () => {
        if (clientProc) {
            vscode.window.showInformationMessage("Already connected to a SmartShare session")
            return;
        }
        const addr = await vscode.window.showInputBox(
            { prompt: "IP Address", value: DEFAULT_ADDR, placeHolder: DEFAULT_ADDR}
        );
        if (!addr) {
            return;
        }
        startClient(addr);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('smartshare.disconnect', async () => {

        // Ask confirmation if user is hosting the session
        if (serverProc) {
            let cancel = false;
            await vscode.window.showWarningMessage("Are you sure you want to stop the server?", { modal: true }, "Yes").then((value) => {
                cancel = value !== "Yes";
            });
            if (cancel) {
                return;
            }
        }

        if (clientProc) {
            clientProc.kill();
        } else {
            vscode.window.showWarningMessage("Already disconnected from SmartShare");
        }

        if (serverProc) {
            serverProc.kill();
        }

    }));

}

export function deactivate() {
    vscode.commands.executeCommand('smartshare.disconnect');
}
