import * as vscode from 'vscode';
import {ChildProcess, ChildProcessWithoutNullStreams, spawn} from 'child_process';
import {log} from './utils';


class Change {

    offset: number;
    delete: number;
    text: string;
    action = 'i_d_e_update';

    constructor(offset: number, deleted: number, inserted: string) {
        this.offset = offset;
        this.delete = deleted;
        this.text = inserted;
    }

    range() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error('No active text editor');
        }
        return new vscode.Range(
            editor.document.positionAt(this.offset),
            editor.document.positionAt(this.offset + this.delete)
        );
    }

}

function writeChange(change: Change) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
    //editor.selections = [...editor.selections, new vscode.Selection(0,0,0,1)]
        editor.edit((editBuilder: vscode.TextEditorEdit) => {
            editBuilder.replace(change.range(), change.text);
        }).then(success => {
            if (success) {
                vscode.window.showInformationMessage('Text inserted');
            } else {
                vscode.window.showErrorMessage('Failed to insert text');
            }
        });
    }
}

export async function activate(context: vscode.ExtensionContext) {

    let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "Disconnected";
    statusBarItem.show();

    let disposable: vscode.Disposable;
    let serverProc: ChildProcessWithoutNullStreams;
    let clientProc: ChildProcessWithoutNullStreams;
    const exePath = __dirname + '/../../../../smartshare/target/debug/';


    context.subscriptions.push(vscode.commands.registerCommand('smartshare.createSession', () => {
        serverProc = spawn(exePath + "server");
        if (!serverProc.pid) {
            vscode.window.showInformationMessage("Failed to start server, aborting")
            return;
        }
        vscode.window.showInformationMessage("Created SmartShare session");
        startClient("127.0.0.1:4903");
    }));


    context.subscriptions.push(vscode.commands.registerCommand('smartshare.joinSession', async () => {

        const addr = await vscode.window.showInputBox(
            {prompt:"IP Address", value:"127.0.0.1"}
        );

        if(!addr) {
            vscode.window.showInformationMessage("Could not get address, aborting")
            return;
        }

        startClient(addr + ":4903");
        
	}));


    function startClient(addr: string) {

        clientProc = spawn(exePath + "client", [addr]);
        if (!clientProc.pid) {
            vscode.window.showInformationMessage("Failed to run executable, aborting")
            return;
        }
        log.info(`Launched client subprocess at pid ${clientProc.pid}`);

        vscode.window.showInformationMessage("Smartshare: Connected to session")
        statusBarItem.text = "Connected";
        clientProc.stdout.setEncoding('utf8');


        clientProc.on('close', () => {
            vscode.window.showErrorMessage("Client closed");
            vscode.commands.executeCommand('smartshare.stop');
        });
        
        var changes_to_discard = new Array();
        var data_line = '';
        
        clientProc.stdout.on("data", function(data) {
            const lines = data.split("\n");
            for (let line of lines) {
                data_line += line;
                if (data_line.length > 0) {
                    log.debug(data_line);
                    data = JSON.parse(data_line);
                    if (data.offset === undefined || data.delete === undefined || data.text === undefined) {
                        vscode.window.showErrorMessage('Received invalid JSON');
                    }
                    const change = new Change(data.offset, data.delete, data.text);
                    writeChange(change);
                    changes_to_discard.push(JSON.stringify(change));
                }
                data_line = ''
            }
            data_line = lines[lines.length-1];
        });
    
        clientProc.stderr.on("data", function(data) {
            log.subprocess(clientProc.pid || 0, data+"");
            console.log(data+"");
        });
    
        
        disposable = vscode.workspace.onDidChangeTextDocument(event => {
    
            console.log(event);
    
            for (let change of event.contentChanges) {
    
                const message = new Change(change.rangeOffset, change.rangeLength, change.text);
    
                if (changes_to_discard[changes_to_discard.length-1] == JSON.stringify(message)) {
                    changes_to_discard.pop();
                } else {
                    console.log(JSON.stringify(message));
                    clientProc.stdin.write(JSON.stringify(message) + '\n');
                }
            }
        });
    
        context.subscriptions.push(disposable);
    }

    function stopClient(disposable: vscode.Disposable, clientProc: ChildProcessWithoutNullStreams) {
        disposable.dispose();
        if (clientProc) {
            clientProc.removeAllListeners();
            clientProc.kill();
            vscode.window.showInformationMessage("Disconnected");
        } else {
            vscode.window.showErrorMessage("Already disconnected");
        }
        statusBarItem.text = "Disconnected";
    }

    context.subscriptions.push(vscode.commands.registerCommand('smartshare.disconnect', async () => {
        if (serverProc) {
            vscode.window.showWarningMessage("Are you sure you want to stop the server?", "Yes", "No").then((value) => {
                if (value === "Yes") {
                    serverProc.removeAllListeners();
                    serverProc.kill();
                    stopClient(disposable, clientProc);
                } else {
                    return;
                }
            });
        } else {
            stopClient(disposable, clientProc);
        }

    }));

}

export function deactivate() {}
