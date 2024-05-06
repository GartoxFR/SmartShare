import * as vscode from 'vscode';
import { logClient, logServer } from './utils';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Ack, Cursors, Cursor, File, Message, RequestFile, TextModification, Update, isMessage, matchMessage } from './message';
import path from 'path';

let waitingAcks = 0;
let toIgnore: string[] = [];
let clientProc: ChildProcessWithoutNullStreams | undefined;
let serverProc: ChildProcessWithoutNullStreams | undefined;
let editor: vscode.TextEditor;
let changeDocumentDisposable: vscode.Disposable;
let changeSelectionsDisposable: vscode.Disposable;
let statusBarItem: vscode.StatusBarItem;
let init = true;
let ignoreNextEvent = false;
let cursorsDecorations: Map<number, vscode.Disposable[]> = new Map();

const EXE_PATH = __dirname + '/../../../../smartshare/target/debug/';
const DEFAULT_ADDR = "127.0.0.1";
const DEFAULT_PORT = "4903";
const CURSOR_COLORS = ["Salmon", "YellowGreen", "SteelBlue", "MediumOrchid", "DarkOrange", "Aqua"];

function procWrite(proc: ChildProcessWithoutNullStreams, message: Message): void {
    logClient.debug("Send message", JSON.stringify(message));
    proc.stdin.write(JSON.stringify(message) + '\n');
}

function updateCursors(cursors: Cursors) {
    let decorations: vscode.Disposable[] = [];
    for (let cursor of cursors.cursors) {
        const range = new vscode.Range(editor.document.positionAt(cursor.cursor), editor.document.positionAt(cursor.anchor));
        let decoration = vscode.window.createTextEditorDecorationType({
            borderWidth: "0 2px 0 0",
            borderStyle: "solid",
            borderColor: CURSOR_COLORS[cursors.id % CURSOR_COLORS.length],
            backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
        });
        decorations.push(decoration);
        editor.setDecorations(decoration, [range]);
    }
    cursorsDecorations.get(cursors.id)?.forEach((decoration) => {
        decoration.dispose();
    });
    cursorsDecorations.set(cursors.id, decorations);
}

async function applyChange(change: TextModification): Promise<boolean> {
    toIgnore.push(JSON.stringify(change));
    let res = await change.write(editor);
    if(!res) {
        const index = toIgnore.indexOf(JSON.stringify(toIgnore));
        toIgnore.splice(index, 1);
    }
    return res;
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
    matchMessage(data)(
        (update: Update) => {
            if (!waitingAcks) {
                (async () => {
                    for (let change of update.changes) {
                        change = new TextModification(change.offset, change.delete, change.text);
                        logClient.debug("trying to apply ", change);
                        if(!await applyChange(change)) {
                            return false;
                        };
                    }
                    return true;
                })().then((success)=>{
                    if (success && clientProc) {
                        procWrite(clientProc, {action: "ack"});
                    }
                })


            } else {
                logClient.debug("Ignore update before acknowledge", update)
            }
        },
        (error: Error) => {
            logClient.error("From client: ", error)
        },
        (_: RequestFile) => {
            if (!clientProc) {
                return;
            }
            vscode.window.showInformationMessage("Created a SmartShare session");
            statusBarItem.text = "Connected";
            procWrite(clientProc, {
                action: "file",
                file: editor.document.getText()
            })
            init = false;
        },
        (file: File) => {
            vscode.window.showInformationMessage("Connected to the SmartShare session");
            statusBarItem.text = "Connected";
            ignoreNextEvent = false;
            let change = new TextModification(0, editor.document.getText().length || 0, file.file);
            change.write(editor).then(() => { init = false });
        },
        (_: Ack) => {
            if (!waitingAcks) {
                logClient.info("Recieved unexpected ack");
            } else {
                waitingAcks--;
            }
        },
        (cursors: Cursors) => {
            updateCursors(cursors);
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
    // if (ignoreNextEvent) {
    //     logClient.debug("ignored changes: " + JSON.stringify(event.contentChanges))
    //     ignoreNextEvent = false
    //     return;
    // }

    let changes = event.contentChanges.map(change => {
        return new TextModification(
            change.rangeOffset,
            change.rangeLength,
            change.text
        )
    });

    let newChanges = [];
    //logClient.debug(toIgnore);
    //logClient.debug(JSON.stringify(changes));
    for(const change of changes) {
        let index = toIgnore.indexOf(JSON.stringify(change));
        if(index != -1) {
            toIgnore.splice(index,1);
        } else {
            newChanges.push(change);
        }
    }
    toIgnore = [];
    if(newChanges.length == 0) {
        return;
    }
    let message: Update = {
        action: "update",
        changes: newChanges
    };
    procWrite(clientProc, message);
    waitingAcks++;
}

function changeSelectionsHandler(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!clientProc) {
        return;
    }
    let cursors: Cursor[] = [];
    for (let selection of event.selections) {
        cursors.push({
            cursor: editor.document.offsetAt(selection.active),
            anchor: editor.document.offsetAt(selection.anchor)
        });
    }
    const message: Cursors = {
        action: "cursor",
        id: 0,
        cursors: cursors
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
        [addr + ":" + DEFAULT_PORT, "--format", "chars"],
        { env: { RUST_LOG: 'trace' } }
    );
    clientProc = client;

    client.on('error', () => {
        vscode.window.showErrorMessage("Failed to start the SmartShare client")
    });

    client.on('spawn', () => {
        logClient.info(`Launched client subprocess at pid ${client.pid}`);
        client.stdout.setEncoding("utf8");
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
        for (let decorations of cursorsDecorations.values()) {
            decorations.forEach((decoration) => {
                decoration.dispose();
            });
        }
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
            { prompt: "IP Address", value: DEFAULT_ADDR, placeHolder: DEFAULT_ADDR }
        );
        if (!addr) {
            return;
        }
        await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
        if (!vscode.window.activeTextEditor) {
            vscode.window.showErrorMessage("Failed to create a new file")
            return;
        }
        editor = vscode.window.activeTextEditor;
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
