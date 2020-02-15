import { Observable, Subscription } from "rxjs";
import { Mutex } from "async-mutex";
import { ModeService } from "../../services/mode.service";

export class Capture<T> {

    private locker: Mutex = new Mutex();
    private sharedLock: Mutex = new Mutex(); // locking this prevents new values from being generated

    constructor(private target: Observable<T | Error>, sharedLock?: Mutex) {
        this.sharedLock = sharedLock || this.sharedLock;
    }

    async start(): Promise<Captured<T>> {
        const release = await this.locker.acquire();
        const sharedRelease = await this.sharedLock.acquire();
        return new Captured<T>(release, this.target, this.sharedLock, sharedRelease);
    }
}

export class Captured<T> {
    private _className: string = "Captured"; public get className(): string { return this._className; }
    private _depth: number = ModeService.depth; private get depth(): number { return this._depth; }

    private _subscription: Subscription;
    private _promise: Promise<T> | undefined;
    private _resolve: Function | undefined;
    private _reject: Function | undefined;
    private _value: T;
    private _error: Error;
    private _released: boolean = false;

    constructor(
        private _release: Function, // lock on capturing new values (future calls to capture.start will block until unlocked)
        private _target: Observable<T | Error>, // capture next value from this
        private _sharedLock: Mutex, // locking this prevents new values from being generated // TODO: this should be used beyond constructor
        _sharedRelease?: Function, // lock on sharedLock
    ) {
        this._subscription = this._target.subscribe(value => this.observedValue(value), error => this.observedError(error), () => this.observedComplete());
        if (_sharedRelease) {
            _sharedRelease();
        }
    }

    public toPromise(): Promise<T> {
        if (this._released)
            return this._error ? Promise.reject(this._error) : Promise.resolve(this._value);
        this._promise = this._promise || new Promise<T>((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
        return this._promise;
    }

    public release(): Promise<Captured<T>> {
        let fn: string = this.depth + ">" + this.className + "#release"; // tslint:disable-line:no-unused-variable
        if (this._released)
            return Promise.resolve(this);
        return this._sharedLock.acquire()
            .then((release: Function) => {
                this.gotError(new Error("Captured observable released before emitting a new value"), release);
            }).catch((err: Error) => {
                err.message = fn + ": Error handling Premature release -- " + err.message;
                this.gotError(err);
            }).then(() => this);
    }

    private gotValue(value: T | Error, release: Function): void {
        let fn: string = this.depth + ">" + this.className + "#gotValue"; // tslint:disable-line:no-unused-variable
        if (this._released)
            throw new Error("Got Value when already released?!");
        if (value instanceof Error) {
            this.gotError(<Error>value, release);
        } else {
            this._value = value;
            if (this._resolve) { this._resolve(this._value); }
            this.cleanup(release);
        }
    }

    private gotError(error: Error, release?: Function): void {
        if (this._released)
            throw new Error("Got Error when already released?!");
        this._error = error;
        if (this._reject) { this._reject(this._error); }
        this.cleanup(release);
    }

    private cleanup(release?: Function): void {
        if (this._released)
            throw new Error("Cleanup Attempted when already released?!");
        this._released = true;
        this._subscription.unsubscribe();
        this._release();
        if (release) {
            release();
        }
    }

    private observedValue(value: T | Error): void {
        this._sharedLock.acquire()
            .then((release: Function) => this.gotValue(value, release))
            .catch((err: Error) => this.gotError(err));
    }

    private observedError(error: Error): void {
        this._sharedLock.acquire()
            .then((release: Function) => this.gotError(error, release))
            .catch((err: Error) => this.gotError(err));
    }

    private observedComplete(): void {
        this.observedError(new Error("Captured observable completed without emitting a new value"));
    }

}
