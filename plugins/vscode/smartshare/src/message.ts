import * as vscode from 'vscode';
import { logClient } from './utils';

export type Message = Update | Declare | Error | RequestFile | File | Ack;

export class Update {
    readonly action: "update"
    offset: number
    delete: number
    text: string

    constructor(offset: number, deleteParam: number, text: string) {
        this.action = "update";
        this.offset = offset;
        this.delete = deleteParam;
        this.text = text;
    }

    range(): vscode.Range {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error('No active text editor');
        }
        return new vscode.Range(
            editor.document.positionAt(this.offset),
            editor.document.positionAt(this.offset + this.delete)
        );
    }

    async write(): Promise<boolean> {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            //editor.selections = [...editor.selections, new vscode.Selection(0,0,0,1)]
            const success = await editor.edit((editBuilder: vscode.TextEditorEdit) => {
                editBuilder.replace(this.range(), this.text);
            });
            if (!success) {
                logClient.error("Unable to apply change", this)
            }
            return success;
        }
        return false;
    }
}

export interface Declare {
    action: "declare"
    offset_format: "bytes" | "char"
}

export interface Error {
    action: "error"
    error: string
}

export interface RequestFile {
    action: "requestFile"
}

export interface File {
    action: "file"
    file: string
}

export interface Ack {
    action: "ack"
}

export function isMessage(object: any): object is Message {
    return object.action in ["update", "declare", "error", "requestFile", "file", "ack"];
}

export function matchMessage(message: Message): any {
    return (
        onUpdate: (x: Update) => any,
        onDeclare: (x: Declare) => any,
        onError: (x: Error) => any,
        onRequestFile: (x: RequestFile) => any,
        onFile: (x: File) => any,
        onAck: (x: Ack) => any
    ) => {
        switch (message.action) {
            case "update":
                return onUpdate(message);
            case "declare":
                return onDeclare(message);
            case "error":
                return onError(message);
            case "requestFile":
                return onRequestFile(message);
            case "file":
                return onFile(message);
            case "ack":
                return onAck(message);
        }
    }
}