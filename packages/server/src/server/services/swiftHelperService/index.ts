import { Server } from "@server/index";
import * as net from "net";
import * as fs from "fs-extra";
import { ChildProcess, spawn } from "child_process";
import { FileSystem } from "@server/fileSystem";
import { generateUuid, isNotEmpty } from "@server/helpers/utils";
import { MessageBatchItem } from "../objCHelperService/MessageBatchItem";

export type TaskData = {
    id: string;
    promise: Promise<NodeJS.Dict<any>>;
    resolve: (value: NodeJS.Dict<any>) => void;
    reject: (reason?: Error) => void;
    isComplete: boolean;
};

/**
 * A class that handles the communication with the swift helper process.
 */
export class SwiftHelperService {
    helperPath: string;

    helper: net.Socket = null;

    child: ChildProcess;

    tasks: TaskData[];

    private runSwiftHelper() {
        this.child = spawn(this.helperPath);
        this.child.stdout.setEncoding("utf8");

        // we should listen to stdout data
        // so we can forward to the bb logger
        this.child.stdout.on("data", (data: string) => {
            console.log("STDOUT");
            try {
                const msg = JSON.parse(data);
                console.log(msg);
                if (msg?.id) {
                    const task = this.tasks.find(task => task.id === msg.id);
                    if (task) {
                        task.resolve(msg?.data);
                    }
                }
            } catch (ex) {
                console.log("failed to decode data");
                console.log(ex);
            }
        });

        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", data => {
            Server().log(`[Swift Helper] Error: ${data}`, "debug");
        });

        // if the child process exits, we should restart it
        this.child.on("close", code => {
            Server().log(`Swift Helper process exited: ${code}`, "debug");
            this.runSwiftHelper();
        });
    }

    /**
     * Initializes the Swift Helper service.
     */
    start() {
        Server().log("Starting Objective-C Helper...");
        this.tasks = [];
        this.helperPath = `${FileSystem.resources}/bluebubblesObjcHelper`;
        this.runSwiftHelper();
    }

    stop() {
        Server().log("Stopping Objective-C Helper...");
        this.tasks = [];

        if (this.child?.stdout) this.child.stdout.removeAllListeners();
        if (this.child?.stderr) this.child.stderr.removeAllListeners();
        if (this.child) {
            this.child.removeAllListeners();
            this.child.kill();
        }

        if (this.helper) {
            this.helper.destroy();
            this.helper = null;
        }
    }

    restart() {
        this.stop();
        this.start();
    }

    createNewTask(): TaskData {
        const task: TaskData = {
            id: generateUuid(),
            promise: null,
            resolve: null,
            reject: null,
            isComplete: false
        };

        task.promise = new Promise((resolve, reject) => {
            task.resolve = (val: NodeJS.Dict<any>) => {
                task.isComplete = true;
                resolve(val);
            };
            task.reject = (reason: Error) => {
                task.isComplete = true;
                reject(reason);
            };
        });

        this.tasks.push(task);
        return task;
    }

    resolveTask(uuid: string, value: NodeJS.Dict<any>) {
        const task = this.tasks.find(task => task.id === uuid);
        if (task) {
            task.resolve(value);
        }
    }

    rejectTask(uuid: string, error: string) {
        const task = this.tasks.find(task => task.id === uuid);
        if (task) {
            task.reject(new Error(error));
        }
    }

    flushTasks() {
        this.tasks.forEach(task => {
            task.reject(new Error("Task was flushed"));
        });

        this.tasks = [];
    }

    /**
     * Sends a Event to the Swift Helper process and listens for the response.
     * @param {Event} msg The Event to send.
     * @param {number} timeout The timeout in milliseconds, defaults to 1000.
     * @returns {Promise<Buffer | null>} A promise that resolves to the response message.
     */
    private async sendMessage(task: TaskData, data: NodeJS.Dict<any>, timeout = 500): Promise<void> {
        return new Promise((resolve, reject) => {
            this.child.stdin.write(JSON.stringify(data) + "\n", err => {
                setTimeout(() => {
                    if (task.isComplete) return;
                    task.reject(new Error("Task timed out"));
                }, timeout);

                if (err) {
                    reject(null);
                } else {
                    resolve(null);
                }
            });
        });
    }

    /**
     * Deserializes an attributedBody blob into a json object using the swift helper.
     * @param {Blob} blob The attributedBody blob to deserialize.
     * @returns {Promise<Record<string, any>>} The deserialized json object.
     */
    async deserializeAttributedBody(bodies: MessageBatchItem[]): Promise<NodeJS.Dict<any>> {
        const msgs = [];
        for (const i of bodies) {
            if (isNotEmpty(i.body)) {
                const buff = Buffer.from(i.body);
                msgs.push({
                    id: i.id,
                    payload: buff.toString("base64")
                });
            }
        }

        const task = this.createNewTask();
        const payload = {
            id: task.id,
            type: "bulk-attributed-body",
            data: msgs
        };

        await this.sendMessage(task, payload);
        return await task.promise;
    }
}
