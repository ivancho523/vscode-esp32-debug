import { DebugProtocol } from "vscode-debugprotocol";
// import { EventEmitter } from "events";
// import * as ChildProcess from "child_process";
import { LoggingDebugSession, DebugSession, TerminatedEvent, InitializedEvent, OutputEvent, ContinuedEvent, Event, Breakpoint, StoppedEvent, Thread, StackFrame, Scope, Variable, Source } from "vscode-debugadapter";
// import * as DebugAdapter from "vscode-debugadapter";
import { BackendService } from "./backend/service";
import { GDBServerController, LaunchConfigurationArgs } from "./controller/gdb";
import { OpenOCDDebugController } from "./controller/openocd";
import { GDBDebugger, DebuggerEvents } from "./backend/debugger";
import { GDBServer } from "./backend/server";
import { Subject } from "await-notify";
import { MIResultThread, MIResultBacktrace, MIResultCreateVaraibleObject, MIResultListChildren, MIResultChildInfo, MIResultChangeListInfo, MIResultStackVariables } from "./backend/mi";
import * as Path from "path";
import { ILogInfo, createLogger } from "./backend/logging";
import { Mutex } from "await-semaphore";


export interface OpenOCDArgments {
    cwd: string;
    executable: string;
    searchDir: string;
    configFiles: string[];
}

export class AdapterOutputEvent extends Event {
    public body: {
        type: string,
        content: string,
        source: string
    };
    public event: string;

    constructor(content: string, type: string, source: string) {
        super('adapter-output', { content: content, type: type, source: source });
    }
}

// const STACK_HANDLES_START = 0;
// const FRAME_HANDLES_START = 256;
const VAR_HANDLES_START = 256 * 256;

export const logger = createLogger();

function ErrorResponseWrapper(target: any, methodName: string, descriptor: PropertyDescriptor): PropertyDescriptor {
    let method: Function = descriptor.value;

    descriptor.value = async function (...args) {
        try {
            await method.apply(this, args);
        } catch (error) {
            logger.error(`[AdapterException] - (${methodName}): ${error}`);
            (this as ESPDebugSession).handleError(args[0], 0, error.message);
        }
    };

    return descriptor;
}

export class ESPDebugSession extends DebugSession {
    private server: BackendService;
    private debugger: GDBDebugger;
    private args: LaunchConfigurationArgs;
    private port: number;

    private controller: GDBServerController;

    protected quit: boolean;
    protected started: boolean;
    protected isDebugReady: boolean = false;
    protected stopped: boolean;
    protected requestHandling: Mutex = new Mutex();

    private _debuggerReady: Subject = new Subject();
    private _initialized: Subject = new Subject();

    public constructor() {
        super();

        this.setDebuggerLinesStartAt1(false);
        this.setDebuggerColumnsStartAt1(false);
        this.setDebuggerPathFormat("native");

        // logger.callback = (log) => {
        //     this.sendEvent(new DebugAdapter.OutputEvent(chalk`${log}`, "stdout"));
        // };
        // logger.addTransport();
        logger.on("log", (info: ILogInfo) => {
            this.sendEvent(new OutputEvent(info.toString(true), "stdout"));

        });

        // logger.on("log", (info: ILogInfo) => {
        //     this.sendEvent(new OutputEvent(`${info.toString(true)}`, "stdout"));
        // });

        // logger.log("info", "Start a debug session.");
        logger.info("Start a debug session.");
        // logger.info("Start a debug session.");
    }

    // Send capabilities
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        logger.debug("Receive an initialize request.");
        // response.body.supportsRestartRequest = true;
        response.body.supportsTerminateRequest = true;
        response.body.supportTerminateDebuggee = true;
        response.body.supportsDelayedStackTraceLoading= false;

        this.sendResponse(response);
        logger.info("Send an initial information.");

        this.sendEvent(new InitializedEvent());
        logger.info("Send an initialized event.");
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchConfigurationArgs): Promise<any> {
        // DebugAdapter.logger.setup(DebugAdapter.Logger.LogLevel.Verbose, false);
        logger.debug("Receive a launch request.");
        // logger.info("Get a launch request");
        let release = await this.requestHandling.acquire();

        // logger.info("Get a launch request.");

        this.args = args;
        // this.controller.on('event', this.controllerEvent.bind(this));

        this.quit = false;
        this.started = false;
        this.isDebugReady = false;
        this.stopped = false;

        // TODO: Run controller.
        this.controller = new OpenOCDDebugController(4444);
        this.controller.setArgs(this.args);

        // TODO: Run server.
        this.server = new GDBServer(
            this.controller.serverApplication(),
            this.controller.serverArgs(),
            this.controller.serverRoot()
            // "."
        );

        this.server.on('output', (output, source) => {this.sendEvent(new AdapterOutputEvent(output, 'out', source));});
        this.server.on('quit', this.onQuit.bind(this));
        this.server.on('launcherror', this.onLaunchError.bind(this));
        this.server.on('exit', (code, signal) => {
            logger.info(`Server process exited. CODE: ${code} SIGNAL:  ${signal}`);
        });

        await this.server.start();
        logger.info("OpenOCD server started.");

        this.debugger = new GDBDebugger(
            this.controller.debuggerApplication(),
            this.controller.debuggerArgs(),
            this.controller.debuggerRoot()
        );
        this.debugger.on('output', (output, source) => {this.sendEvent(new AdapterOutputEvent(output, 'out', source));});

        this.debugger.on(DebuggerEvents.ExecStopped, (threadId) =>
        {
            let e: DebugProtocol.StoppedEvent = new StoppedEvent('stop', threadId);
            e.body.allThreadsStopped = true;

            this.sendEvent(e);
            logger.info(`Send a stop event. Thread: ${threadId}`);
        });

        await this.debugger.start();
        logger.info("GDB debugger started.");
        this.debugger.run();

		await this.debugger.enqueueTask("gdb-set target-async on");
        await this.debugger.enqueueTask("enable-pretty-printing");
        await this.debugger.enqueueTask("interpreter-exec console \"target remote localhost:3333\"");
        await this.debugger.enqueueTask("interpreter-exec console \"monitor reset halt\"");
        await this.debugger.enqueueTask("break-insert -t -h app_main");
        await this.debugger.enqueueTask("exec-continue");

        this.debugger.isInitialized = true;
        logger.debug("Debugger is ready. [Notification]");
        this._waiters.forEach(
            (notify) => {
                notify();
            }
        );
        // this._debuggerReady.notifyAll();
        this.isDebugReady = true;
        release();

        // this.debugger.start().then(async () => {
        // 	console.info("GDB debugger started.");
        // 	this.debugger.run();


        // 	await this.debugger.enqueueTask("interpreter-exec console \"target remote localhost:3333\"");
        // 	// await Promise.all(
        // 	// 	[
        // 	// 		this.debugger.executeCommand("gdb-set target-async on"),
        // 	// 		this.debugger.executeCommand("interpreter-exec console \"target remote localhost:3333\""),
        // 	// 		this.debugger.executeCommand("interpreter-exec console \"monitor reset halt\""),
        // 	// 		this.debugger.executeCommand("break-insert -t -h app_main")
        // 	// 	]
        // 	// );
        // 	this._debuggerReady.notifyAll();
        // 	this.debugger.isInitialized = true;

        // 	// await this.debugger.executeCommand("exec-continue");

        // });


        // this.controller.serverLaunchStarted();
        // this.server.init().then(() => {
        // 	this.controller.serverLaunchCompleted();

        // 	let gdbArgs = ['-q'];
        // 	gdbArgs = gdbArgs.concat(this.args.serverArgs || []);
        // });

        // Lauch Request
        // 1. Run controller
        // 2. Run server
        // 3. Register events

        this.sendResponse(response);

    }

    @ErrorResponseWrapper
    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<any> {
        logger.debug("Receive an evaluate request.");

        let context = args.context;
        let result= undefined;

        switch(context) {
            case "repl":
                result = await this.debugger.enqueueTask(args.expression);
                break;
        }

        response.body = {
            result: JSON.stringify(result),
            variablesReference: 0
        };

        this.sendResponse(result);
    }

    public breakpointMap = new Map<string, number[]>();
    public breakpointHandles = new Handles<DebugProtocol.Breakpoint>(2);

    @ErrorResponseWrapper
    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<any> {
        logger.debug("Receive a setBreakPoints request.");

        const path: string = Path.normalize(args.source.path);
        const currentBreakpoints: DebugProtocol.SourceBreakpoint[] = args.breakpoints || [];

        let release = await this.requestHandling.acquire();

        if (!this.isDebugReady){
            release();
            let timeout = await new Promise(
                (resolve) =>
                {
                    let callback = () =>
                    {
                        resolve(true);
                    };

                    this._waiters.push(callback);

                    setTimeout(
                        () =>
                        {
                            resolve(false);
                        },
                        10000
                    );
                }
            );
            if (!timeout) {
                logger.warn("Timeout - {setBreakPointsRequest}");
            }
            else {
                this.isDebugReady = true;
            }

            release = undefined;
        }

        // Clear all bps for this file.
        await this.debugger.clearBreakpoints(this.breakpointMap.get(path) || []);

        // Set and verify bp locations.
        let handles = [];
        let actualBreakpoints = await Promise.all(
            currentBreakpoints.map(
                async (bp) => {
                    let result = await this.debugger.setBreakpoint(path, bp);
                    let returnBp = new Breakpoint(true, result["line"]);

                    handles.push(this.breakpointHandles.create(returnBp));

                    return returnBp;
                }
            )
        );

        this.breakpointMap.set(path, handles);

        response.body = {
            breakpoints: actualBreakpoints
        };

        if (release) {
            release();
        }
        this.sendResponse(response);
    }

    static CreateThreads(record: MIResultThread): Array<DebugProtocol.Thread> {
        return record.threads.map(
            (thread) =>
            {
                // Default starts from one, change it starts from zero.
                let id = parseInt(thread["id"]);
                let name = `Thread #${id} ${RegExp(/([0-9]+)/).exec(thread["target-id"])[0]}`;

                return new Thread(
                    id,
                    name
                );
            }
        );
    }

    private _waiters: Array<Function> = [];

    @ErrorResponseWrapper
    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        logger.debug("Receive a threads request.");

        let release = await this.requestHandling.acquire();

        if (!this.isDebugReady)
        {
            release();
            let timeout = await new Promise(
                (resolve) => {
                    let id = setTimeout(
                        () => {
                            resolve(false);
                        },
                        10000
                        );

                    let callback = () => {
                        resolve(true);
                        clearTimeout(id);
                    };
                    this._waiters.push(callback);

                }
            );
            // let timeout = await this._debuggerReady.wait(10000);
            if (!timeout)
            {
                logger.warn("Timeout - {threadsRequest}");
                // throw new Error("Timeout");
            }
            else
            {
                this.isDebugReady = true;
            }

            release = undefined;
        }

        let record: MIResultThread = await this.debugger.getThreads();

        response.body = {
            threads: ESPDebugSession.CreateThreads(record).reverse()
        };

        if (release)
        {
            release();
        }
        this.sendResponse(response);
    }

    private createSource(frame: any): Source {
        return new Source(
            Path.basename(frame["file"]),
            frame["fullname"]
        );
    }

    // Maximum depth of frame to 256.
    // Maximun number of threads to 256.
    static ToFrameID(threadID: number, level: number): number {
        return threadID << 8 | level;
    }

    static FromFrameID(frameID: number): [number, number] {
        return [ (frameID >> 8) & 0xff, frameID & 0xff ];
    }

    private createStackFrames(record: MIResultBacktrace, threadID: number): Array<DebugProtocol.StackFrame> {
        return record.stack.map(
            (element) => {
                let stackframe = new StackFrame(
                    ESPDebugSession.ToFrameID(threadID, parseInt(element.frame["level"])),
                    element.frame["func"] + "@" + element.frame["addr"]
                );

                if (element.frame.hasOwnProperty("file"))
                {
                    stackframe.source = this.createSource(element.frame);
                    stackframe.line = parseInt(element.frame["line"]);

                    return stackframe;
                }
                else {
                    return stackframe;
                }
            }
        );
    }

    public selectedThreadId: number = 0;
    public selectedFrameId: number = 0;

    @ErrorResponseWrapper
    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        logger.debug(`Receive a stackTrace request: threadID: ${args.threadId} | startFrame: ${args.startFrame} | level: ${args.levels}`);
        let record: MIResultBacktrace = await this.debugger.getBacktrace(args.threadId);
        this.selectedThreadId = args.threadId;

        response.body = {
            stackFrames: this.createStackFrames(record, this.selectedThreadId)
        };
        this.sendResponse(response);
    }

    @ErrorResponseWrapper
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void
    {
        logger.debug("Receive a scopes request.");
        this.selectedFrameId = args.frameId;

        response.body = {
            scopes: [
                new Scope("Local", this.selectedFrameId, false),
                // new Scope("Global", 254, true),
                // new Scope("Static", 65536 + this.selectedFrameId, false)
            ]
        };
        this.sendResponse(response);
    }

    public variableHandles = new Handles<VariableObject>(VAR_HANDLES_START);


    private async updateVariables(): Promise<any> {
        let result = await this.debugger.updateVariableObjects();

        result["changelist"].forEach(
            (element) => {
                let varObj = this.variableHandles.getValueFromIdentity(element["name"]);
                varObj.update(element);
            }
        );
    }

    private async createStackVariables(record: MIResultStackVariables): Promise<any> {
        let variables = record["variables"];

        try {
            await this.updateVariables();
        } catch (error) {
            logger.error(`[updateVariables] - ${error}`);
        }

        let ret = await Promise.all(
            variables.map(
                async (variable: Object) => {
                    let varExp,varName,varObj,ref;

                    try {
                        varExp = variable["name"];
                        varName = `Local_Var_(${varExp})`;
                        varObj = undefined;
                        ref = 0;

                        if(this.variableHandles.hasIdentity(varName)) {
                            varObj = this.variableHandles.getValueFromIdentity(varName);
                            ref = this.variableHandles.getHandleFromIdentity(varName);
                        }
                        else {
                            let result = await this.debugger.createVariableObject(varName, varExp);
                            varObj = new VariableObject(result, varExp);
                            ref = this.variableHandles.create(varObj, varName);
                        }

                        return varObj.toProtocolVariable(ref);
                    } catch (error) {
                        logger.error(`[${varExp}] - ${error}`);
                    }
                }
            )
        );

        return ret;
    }

    private async createVariableChildren(record: MIResultListChildren): Promise<any> {
        // await this.updateVariables();

        if (record["numchild"] === "0") {
            return Promise.resolve([]);
        }

        let children = record["children"];

        let ret = await Promise.all(
            children.map(
                async (element) => {
                    let child = element["child"];
                    let varName = child["name"];
                    let varObj = undefined;
                    let ref = 0;

                    if (this.variableHandles.hasIdentity(varName)) {
                        varObj = this.variableHandles.getValueFromIdentity(varName);
                        ref = this.variableHandles.getHandleFromIdentity(varName);
                    }
                    else {
                        varObj = new VariableObject(child);
                        ref = this.variableHandles.create(varObj, varName);
                    }

                    return varObj.toProtocolVariable(ref);
                }
            )
        );

        return ret;
    }

    @ErrorResponseWrapper
    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void>
    {
        logger.debug("Receive a variables request.");

        let id: number = 0;
        let record = undefined;
        let variables: Variable[] = undefined;

        if (args.variablesReference < VAR_HANDLES_START) {
            // Stack Variables Req.
            let frameID: number = args.variablesReference;
            let [threadId, level] = ESPDebugSession.FromFrameID(frameID);
            record = await this.debugger.getStackVariables(threadId, level);

            variables = await this.createStackVariables(record);
        }
        else {
            // Variable Member Req.
            let varID: VariableObject = this.variableHandles.get(args.variablesReference);
            record = await this.debugger.getVariableChildren(varID.name);

            variables = await this.createVariableChildren(record);
            // record = await this.debugger.getVariableMember(varID);
        }

        // let frameID: number = args.variablesReference - STACK_HANDLES_START;
        // let variables: DebugProtocol.Variable[] = this.createVariables(record);

        response.body = {
            variables: variables
        };

        this.sendResponse(response);
    }

    @ErrorResponseWrapper
    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        logger.debug("Receive a disconnect request.");

        this.onQuit(response);
    }

    @ErrorResponseWrapper
    protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments): void {
        logger.debug("Receive a terminate request.");
        this.server.exit();
        this.debugger.exit();
        this.sendEvent(new TerminatedEvent(false));
        this.sendResponse(response);
	}

    @ErrorResponseWrapper
	protected async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): Promise<any> {
        logger.debug("Receive a pause request.");
		await this.debugger.interrupt();
		// await this.debugger.interrupt(args.threadID);

		this.sendResponse(response);
	}

    @ErrorResponseWrapper
	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<any> {
        logger.debug("Receive a continue request.");
		await this.debugger.continue();

        this.sendEvent(new ContinuedEvent(args.threadId, true));
		this.sendResponse(response);
	}

    @ErrorResponseWrapper
	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<any> {
        logger.debug("Receive a stepIn request.");
		await this.debugger.step(args.threadId);

        this.sendEvent(new ContinuedEvent(args.threadId, true));
		this.sendResponse(response);
	}

    @ErrorResponseWrapper
	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<any> {
        logger.debug("Receive a stepOut request.");
		await this.debugger.stepOut(args.threadId);

        this.sendEvent(new ContinuedEvent(args.threadId, true));
        this.sendResponse(response);
	}

    @ErrorResponseWrapper
	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<any> {
        logger.debug("Receive a next request.");
		await this.debugger.next();

        this.sendEvent(new ContinuedEvent(args.threadId, true));
		this.sendResponse(response);
	}

    protected onQuit(response) {
        if (this.started) {
            this.started = false;
            this.sendEvent(new TerminatedEvent(false));
        }
        else {
            this.sendErrorResponse(
                response,
                103,
                `${this.controller.name} GDB Server quit unexpectedly.`
            );
        }
    }

    protected onLaunchError(err: number, response) {
        this.sendErrorResponse(response, 103, `Fail to launch ${this.controller.name} GDB Server: ${err.toString()}`);
    }

    public handleError(response: any, errCode: number, message: string) {
        this.sendErrorResponse(response, errCode, message);
    }
}

class VariableObject {
    public name: string;
    public exp: string;
    public numChild: number;
    public value: any;
    public type: string;
    public threadID: number;
    public hasMore?: number;

    constructor(record: MIResultCreateVaraibleObject | MIResultChildInfo, exp?: string) {
        this.name = record["name"];

        // TODO: Should have an appropriate method.
        if (exp) {
            this.exp = exp;
        }
        else {
            this.exp = record["exp"];
        }

        this.numChild = parseInt(record["numchild"]);
        this.value = record["value"];
        this.type = record["type"];
        this.threadID = parseInt(record["thread-id"]);

        if (record.hasOwnProperty("has_more")) {
            this.hasMore = parseInt(record["has_more"]);
        }
    }

    public update(record: MIResultChangeListInfo) {
        this.name = record["name"];
        this.value = record["value"];
        // this.numChild = record["new_num_children"];
    }

    public toProtocolVariable(ref: number): DebugProtocol.Variable {

        return {
            name: this.exp,
            // identity: this.name,
            type: this.type,
            value: this.value,
            variablesReference: this.numChild === 0? 0 : ref
        };
    }
}

export class Handles<T> {

	private START_HANDLE = 1000;

	private _nextHandle : number;
    private _handleMap = new Map<number, T>();
    // private _handleIdentitySet = new Set<string>();
    private _handleMapReverse = new Map<T | string, number>();

	public constructor(startHandle?: number) {
		this._nextHandle = typeof startHandle === 'number' ? startHandle : this.START_HANDLE;
	}

	public reset(): void {
		this._nextHandle = this.START_HANDLE;
        this._handleMap = new Map<number, T>();
        this._handleMapReverse = new Map<T | string, number>();
        // this._handleIdentitySet = new Set<string>();
	}

	public create(value: T, identity?: string): number {
		let handle = this._nextHandle++;
        this._handleMap.set(handle, value);
        if (identity) {
            this._handleMapReverse.set(identity, handle);
        }
        else {
            this._handleMapReverse.set(value, handle);
        }
        // if (identity) {
        //     this._handleIdentitySet.add(identity);
        // }
		return handle;
	}

	public get(handle: number, dflt?: T): T {
		return this._handleMap.get(handle) || dflt;
    }

    public getValueFromIdentity(identity: string): T {
        return this._handleMapReverse.has(identity)? this._handleMap.get((this._handleMapReverse.get(identity))) : undefined;
    }

    public getHandleFromIdentity(identity: string): number {
        return this._handleMapReverse.has(identity)? (this._handleMapReverse.get(identity)) : undefined;
    }

    public hasIdentity(identity: string): boolean {
        return this._handleMapReverse.has(identity);
    }

    // public toHandleArray()
}

DebugSession.run(ESPDebugSession);