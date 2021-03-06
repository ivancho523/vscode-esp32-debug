import { BackendService, IBackendService, ServiceType } from "./service";
import { MINode, parseMI } from "./mi_parse";
import { DebugProtocol } from "vscode-debugprotocol";
import * as vscode from "vscode";
import { instanceOfMIResult, instanceOfMIAsyncRecord, instanceOfMIStream, MIResult } from "./mi";
import { logger } from "../esp";

interface Task {
    token: number;
    cmd: string;
    onFinished: Function;
}

export enum DebuggerEvents {
    ExecStopped = "1",

}

function HandleRecordException(target: any, methodName: string, descriptor: PropertyDescriptor): PropertyDescriptor {
    let method: Function = descriptor.value;

    descriptor.value = async function (...args) {
        let ret: MIResult = undefined;

        try {
            ret = await method.apply(this, args);

            if (ret.resultClass === "error") {
                throw new Error(`[DebuggerRecordException] - (${methodName}): ${ret.msg}`);
            }

            return ret;
        } catch (error) {
            logger.error(`[DebuggerException] - (${methodName}): ${error}`);
        }
    };

    return descriptor;
}

export class GDBDebugger extends BackendService implements IBackendService
{
    public pendingTasks: Map<number, (string) => void> = new Map();
    public incToken: number = 0;
    public isInitialized: boolean = false;
    public isRunning: boolean = false;

    private _taskQ: Array<Task> = [];
    private _pendingTask: any = { onReceived: undefined };
    private _waiters: Map<string, () => void> = new Map();

    private _breakpoints: Map<string, DebugProtocol.SourceBreakpoint[]> = new Map();

    constructor(application: string, args: string[], public root?: string, public cwd?: string, public path?: string[])
    {
        super("Subprocess for GDB Debugger Instance", ServiceType.Debugger, application, args);

        if (this.root === undefined)
        {
            this.root = "C:\\msys32";
        }

        if (this.path === undefined)
        {
            this.path = [
                "mingw32\\bin",
                "usr\\local\\bin",
                "usr\\bin",
                "bin",
                "opt\\xtensa-esp32-elf\\bin"
            ];
        }

        this.setOptions({
            cwd: ".",
            env: BackendService.parseEnv(this.root, this.path)
        });

        // this._taskQ = [];
    }

    public enqueueTask(cmd: string, priority?: boolean): Promise<any> {

        // wait for completing
        return new Promise(
            (resolve, reject) => {
                let notify = (result: MIResult) => {
                    resolve(result);
                };

                this.incToken ++;
                let task = {
                    token: this.incToken,
                    cmd: cmd,
                    onFinished: notify
				};
				if (priority) {
					this._taskQ.unshift(task);
				}
				else {
					this._taskQ.push(task);
				}

            }
        );
    }

    private _id;
    public run(): void {
        this._id = setTimeout(
            this.dispatchTask.bind(this), 10
        );
    }

    // public stop(): void {
    // 	clearInterval(this._id);
    // }

    public async dispatchTask(): Promise<any> {
        if (this._taskQ.length > 0) {
            if (!this.isRunning) {
                let task = this._taskQ.shift();
                let result = await this.sendRaw(task);

                // notify to original request
                task.onFinished(result);
                logger.info(`Task ${task.token} finished.`);
                logger.info(`Result: ${JSON.stringify(result)}`);
            }

        }

        this.run();
        // else {
        // 	return Promise.resolve();
        // }
    }

    public sendRaw(task: any): Promise<any> {

        return new Promise(
            (resolve, reject) => {
                let notify = (result: MIResult) => {
                    resolve(result);
                };

                this._pendingTask.onReceived = notify;
                this.process.stdin.write(task.token.toString() + "-" + task.cmd + "\n");
                logger.info(`Send Command No.${task.token} "${task.cmd}"`);

            }
        );
    }

    public sendCommand(cmd: string): Promise<any> {
        this.incToken ++;
        this.process.stdin.write(this.incToken.toString() + "-" + cmd + "\n");
        logger.info(`Send Command No.${this.incToken} "${cmd}"`);

        return new Promise(
            (resolve, reject) => {
                let callback = (record: string) =>
                {
                    if (record)
                    {
                        resolve(record);
                        // logger.info(result);
                    }
                    else {
                        reject();
                    }
                };

                this.pendingTasks.set(this.incToken, callback);
            }
        );
    }

    public async executeCommand(cmd: string): Promise<any> {
        let record = await this.sendCommand(cmd);

        this.pendingTasks.delete(record.token);
        logger.info(`Command No.${record.token} "${cmd}" finished.`);
        logger.info(`Command No.${record.token} result: ${JSON.stringify(record)}.`);

        return record;
    }

    public async executeCommands(cmds: string[]): Promise<void> {
        cmds.forEach(
            async (cmd) => {
                await this.executeCommand(cmd);
            }
        );
    }

    public waitForNotify(waiter: string) {
        return new Promise(
            (resolve) => {
                let callback = () =>
                {
                    resolve();
                };

                this._waiters.set(waiter, callback);
            }
        );
    }

    public postProcess(content: string): Array<any>
    {
        // logger.info(content);
        let records = parseMI(content);
        // logger.info(records);

        records.forEach(
            (record) => {
                if (record.token) {
                    this._pendingTask.onReceived(record);
                    // this.pendingTasks.get(record.token)(record);
                }


                if (instanceOfMIResult(record))
                {
                    switch (record.resultClass)
                    {
                        case "done":

                        // this.emit()
                    }

                }
                else if (instanceOfMIAsyncRecord(record))
                {
                    switch (record.asyncClass)
                    {
                        case "stopped":
                            if (this.isInitialized){
                                this.emit(DebuggerEvents.ExecStopped, parseInt(record["thread-id"]));
                            }
                            this.isRunning = false;

                            // if (this._waiters.has("Stop")) {
                            // 	this._waiters.get("Stop")();
                            // }
                            break;
                            // TODO: Bug?
                        case "running":
                            this.isRunning = true;
                            break;
                    }
                }
                else if (instanceOfMIStream(record))
                {

                }
                else { }
            }
        );

        return records;
    // 	if (record.token) {
    // 		this.pendingTasks.get(record.token)(content);
    // 	}
    // 	return record;
    }

    @HandleRecordException
    public async setBreakpoint(path: string, bp: DebugProtocol.SourceBreakpoint): Promise<any>
    {
        // if (this._breakpoints.has(path)) {
        //     this._breakpoints.get(path).push(bp);
        // }
        // else {
        //     this._breakpoints.set(path, [ bp ]);
        // }

        let result = await this.enqueueTask(`break-insert ${path}:${bp.line} `);

        return result;
    }

    @HandleRecordException
    public async clearBreakpoints(bps: Array<number>): Promise<any> {
        let deleteTasks = await Promise.all(
            bps.map(
                async (bp) => {

                    await this.clearBreakpoint(bp);
                }
            )
        );

        // return new Promise(
        // 	async (resolve, reject) => {
        // 		let record = await this.executeCommand("break-delete");

        // 	}
        // );
    }

    @HandleRecordException
    public async clearBreakpoint(number: number): Promise<any> {
        let result = await this.enqueueTask(`break-delete ${number}`);

        return result;
        // return new Promise(
        //     async (resolve, reject) => {
        //         let result = await this.enqueueTask(`break-delete ${number}`);

        //         if (result.isDone) {
        //             resolve(result);
        //         }
        //         else {
        //             reject(false);
        //         }
        //     }
        // );
    }

    @HandleRecordException
    public async getThreads(threadID?: number): Promise<any> {
        let result = await this.enqueueTask(`thread-info`);
        // let result = await this.executeCommand(`thread-info`);

        return result;
    }

    @HandleRecordException
    public async getBacktrace(threadID?: number): Promise<any> {
        await this.enqueueTask(`thread-select ${threadID}`);
        let result = await this.enqueueTask("stack-list-frames", true);

        return result;
    }

    @HandleRecordException
    public async getScope(frameId?: number): Promise<any> {
        await this.enqueueTask(`stack-select-frame ${frameId}`);
        // let result = await this.enqueueTask(`stack-list`)
        return undefined;
    }

    @HandleRecordException
    public async getStackVariables(threadID: number, frameId: number): Promise<any> {
        let result = await this.enqueueTask(`stack-list-variables --thread ${threadID} --frame ${frameId} --simple-values`);

        return result;
    }

    @HandleRecordException
    public async createVariableObject(varName: string, varExp: string): Promise<any> {
        let result = await this.enqueueTask(`var-create ${varName} * ${varExp}`);

        return result;

    }

    @HandleRecordException
    public async updateVariableObjects(): Promise<any> {
        let result = await this.enqueueTask(`var-update --all-values *`);

        return result;
    }

    @HandleRecordException
    public async getVariableChildren(varName: string): Promise<any> {
        let result = await this.enqueueTask(`var-list-children --simple-values ${varName}`);

        return result;
    }

    @HandleRecordException
	public async interrupt(threadID?: number): Promise<any> {
		// Request "Interrupt" has the highest priority,
		// "isRunning" state will be ignored.
		this.isRunning = false;
		let result = await this.enqueueTask(`exec-interrupt`, true);

		return result;
	}

    @HandleRecordException
	public async continue(threadID?: number): Promise<any> {
		let result = await this.enqueueTask(`exec-continue`);

		return result;
	}

    @HandleRecordException
	public async step(threadID: number): Promise<any> {
        // await this.enqueueTask(`thread-select ${threadID}`);
		let result = await this.enqueueTask(`exec-step`, true);

		return result;
	}

    @HandleRecordException
	public async stepOut(threadID: number): Promise<any> {
        // await this.enqueueTask(`thread-select ${threadID}`);
		let result = await this.enqueueTask(`exec-finish`, true);

		return result;
	}

    @HandleRecordException
	public async next(): Promise<any> {
		let result = await this.enqueueTask(`exec-next`);

		return result;
	}
}

interface Breakpoint {
    number: number;
    addr: string;
    file: string;
    fullname: string;
    line: number;
    threadGroups: string[];
    times: number;
}