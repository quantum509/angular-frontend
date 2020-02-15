import { UserManager, User } from "oidc-client";
import { Subscription, Subject } from "rxjs";

import { Mutex } from "async-mutex";

import { LoginConfig } from "../models/login-config.model";

import { AuthResponse } from "../models/role-authorizations.model";
import { ApiService } from "../services/api.service";  // Used to getAuthorizations
import { ModeService } from "../services/mode.service";
import { Capture } from "../lib/capture/capture.lib";

export class LoginService {
  private className: string = "LoginService";

  private mgr: UserManager;
  private currentUser: User;
  private auths: string[];

  private privateLock: Mutex = new Mutex();    // lock in (private) methods that set currentUser: clearAuth and onUserLoaded
  private publicLock: Mutex = new Mutex(); // lock in PUBLIC methods: constructor, getCurrentUser, getUserOrLogin, logOut -- ONLY INSIDE awaitInit

  private userEvents: Subject<User | Error> = new Subject<User | Error>();
  private userLoadedEvents: Subject<User> = new Subject<User>(); // userEvents filtered to emit only Users
  private userErrorEvents: Subject<Error> = new Subject<Error>(); // userEvents filtered to emit only Errors

  private loginConfig: LoginConfig;

  private initializeEvent: () => void;
  private awaitInit: Promise<void>;
  private userLoadedCapture: Capture<User | Error> = new Capture<User | Error>(this.userEvents, this.privateLock);

  public modeService: ModeService;
  public get isInitialized(): boolean { return !!this.mgr; }
  public get hasUser(): boolean { return !!this.currentUser; }
  public get hasAuthorizations(): boolean { return !!this.auths; }
  public get userObject(): User | undefined { return this.currentUser; }
  public get oldState(): string { return this.currentUser && this.currentUser.state; } // TODO: elvisize
  public get userID(): string { return this.currentUser && this.currentUser.profile.gsupersonpantherid; } // TODO: elvisize
  public get userName(): string { return this.currentUser && this.currentUser.profile.user_name; } // TODO: elvisize
  public get email(): string { return this.currentUser && this.currentUser.profile.email; } // TODO: elvisize
  public get realName(): string { return this.currentUser && this.currentUser.profile.name; } // TODO: elvisize
  public get givenName(): string { return this.currentUser && this.currentUser.profile.given_name; } // TODO: elvisize
  public get familyName(): string { return this.currentUser && this.currentUser.profile.family_name; } // TODO: elvisize
  public get bearerToken(): string | undefined { return this.currentUser && this.currentUser.access_token; } // TODO: elvisize
  public get headers(): { [key: string]: string } | undefined {
    if (this.currentUser) {
      return {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + this.bearerToken
      };
    }
  }

  constructor() {
    this.modeService = new ModeService();
    this.awaitInit = new Promise((resolve) => this.initializeEvent = resolve);
    this.userEvents.subscribe((e: User | Error | undefined) => {
      if (e instanceof Error) {
        this.userErrorEvents.next(e);
      } else {
        this.userLoadedEvents.next(e);
      }
    });
  }

  public initialize(loginConfig: LoginConfig, allowredirect?: boolean, stateinfo?: string | undefined): Promise<void> {
    if (!this.loginConfig) {
      this.loginConfig = loginConfig; // technically, this should be inside a lock
      this.mgr = new UserManager(this.loginConfig);
      this.initializeEvent();
      this.mgr.events.addUserLoaded((user: User) => this.onUserLoaded(user));
      this.mgr.events.addAccessTokenExpired(() => this.onUserUnloaded("UserManager emitted AccessTokenExpired"));
      this.mgr.events.addUserUnloaded(() => this.onUserUnloaded("UserManager emitted UserUnloaded"));
      return this.processMode();
    } else if (loginConfig === this.loginConfig) {
      return Promise.resolve();
    } else {
      return Promise.reject(new Error("Cannot Initialize loginService More Than Once!"));
    }
  }

  private processMode(allowredirect: boolean = false, stateinfo?: string | undefined) {
    return this.doSafeUserAction(this.publicLock, () => {
      switch (this.modeService.mode) {
        case "embedded":  // getOrRecover
          return this.getOrRecoverUser();
        case "silent":  // Process silent redirect, no fallback
          return this.captureAndCallback(() => this.mgr.signinSilentCallback(this.modeService.login_query));
        case "login":  // Process login redirect, fallback on recovery
          return this.captureAndCallback(() => this.mgr.signinRedirectCallback(this.modeService.login_query), () => this.logInSilent());
        case "normal":
          return allowredirect ? this.recoverUserOrLogin(stateinfo) : this.getOrRecoverUser();
      }
    }).catch(() => { });
  }
  public subscribe(subscriber: (value: User) => void): Subscription { return this.userLoadedEvents.subscribe(subscriber); }
  public subscribeAll(subscriber: (value: User | Error) => void): Subscription { return this.userEvents.subscribe(subscriber); }

  private clearAuth(): Promise<void> {
    return this.doSafeUserAction(this.privateLock, () => {
      if (this.currentUser) {
        this.mgr.clearStaleState();
        this.mgr.removeUser();
        delete this.currentUser;
        this.userEvents.next(undefined);
      }
    });
  }

  public async getAuthorizations(): Promise<string[]> {
    if (typeof this.auths === "undefined")
      this.auths = await this.getCurrentUser()
        .then(async () => ApiService.get(this.loginConfig.BANNER_URL, "roleAuthorizations", this.headers))
        .then((auths: AuthResponse) => auths.authList);

    return this.auths;
  }

  public async canViewAs(): Promise<boolean> {
    if (!this.auths)
      this.auths = await this.getAuthorizations();
    return this.auths && this.auths.indexOf("viewAs") >= 0;
  }

  public async getCurrentUser(): Promise<User> {
    if (this.checkUser)
      return Promise.resolve(this.currentUser);
    return this.doSafeUserAction(this.publicLock, () => this.checkUser ? this.currentUser : this.recoverUser());
  }

  private getUserOrFail(error?: string): Promise<User> {
    return this.checkUser ? Promise.resolve(<User>this.currentUser) : Promise.reject(new Error(error));
  }

  public getUserOrLogin(stateinfo?: string | undefined): Promise<User> {
    if (this.checkUser)
      return Promise.resolve(this.currentUser as User); // currentUser not undefined when checkUser returns true

    return this.doSafeUserAction(this.publicLock, () => this.currentUser || this.recoverUserOrLogin(stateinfo));
  }

  private getOrRecoverUser(): Promise<User> {
    return this.currentUser ? Promise.resolve(this.currentUser) : this.recoverUser();
  }

  private recoverUserOrLogin(stateinfo?: string | undefined): Promise<User> {
    let fn: string = this.modeService.depth + ">" + this.className + "#recoverUserOrLogin";
    return this.recoverUser()
      .then(() => this.getUserOrFail((fn + ": User recovered to " + this.currentUser)))
      .catch((err: any) => {
        return this.logInInteractive(stateinfo)
          .then(() => this.getUserOrFail((fn + ": Interactive login resolved to " + this.currentUser)));
      });
  }

  public get checkUser(): boolean {
    return !!this.currentUser && !this.currentUser.expired;
  }

  private recoverUser(): Promise<User> {
    let fn: string = this.modeService.depth + ">" + this.className + "#recoverUser";
    return this.logInSilent()
      .then(() => this.getUserOrFail((fn + ": Silent login resolved to " + this.currentUser)));
  }

  private logInInteractive(stateinfo?: string | undefined): Promise<User> {
    let fn: string = this.modeService.depth + ">" + this.className + "#logInInteractive";
    if (this.modeService.embedded)
      return Promise.reject("This frame was unable to find your login session.");

    return this.logInRedirect(stateinfo)
      .then(() => this.getUserOrFail((fn + ": Redirect login resolved to " + this.currentUser)));
  }

  private logInRedirect(stateinfo?: string | undefined): Promise<User> {
    let fn: string = this.modeService.depth + ">" + this.className + "#logInRedirect";
    let stateobj: any = stateinfo ? { state: stateinfo } : undefined; // TODO: don't use type any

    return this.captureAndCallback(
      () => this.mgr.signinRedirect(stateobj)
      , undefined
      , () => this.getUserOrFail((fn + ": Redirect login resolved to " + this.currentUser))
    );
  }

  private logInSilent(): Promise<User> {
    let fn: string = this.modeService.depth + ">" + this.className + "#logInSilent";

    return this.captureAndCallback(
      () => this.mgr.signinSilent()
      , undefined
      , () => this.getUserOrFail((fn + ": Silent login resolved to " + this.currentUser))
    );
  }

  public logOut(): Promise<void> {
    return this.doSafeUserAction(this.publicLock, () => this.mgr.signoutRedirect().then(() => this.clearAuth()));
  }

  private onUserLoaded(user: User): void {
    let fn: string = this.modeService.depth + ">" + this.className + "#onUserLoaded";
    if (!user) {
      this.userEvents.next(new Error("Invalid user (false) = " + JSON.stringify(user)));
    } else if (user.expired) {
      this.userEvents.next(new Error("Invalid user (expired," + user.expires_in + ")"));
    } else {
      this.doSafeUserAction(this.privateLock, () => {
        this.currentUser = user;
        this.userEvents.next(user);
      }).catch((err: Error) => {
        err.message = fn + ": Failed while or after acquiring userLock -- " + err.message;
        this.userEvents.next(err);
      });
    }
  }

  private onUserUnloaded(from: string): void {
    let fn: string = this.modeService.depth + ">" + this.className + "#onUserUnloaded";
    this.doSafeUserAction(this.privateLock, () => {
      if (this.currentUser) {
        delete this.auths;
        delete this.currentUser;
        this.userEvents.next(undefined);
      }
    }).catch((err: Error) => {
      err.message = fn + ": Failed while or after acquiring userLock -- " + err.message;
      this.userEvents.next(err);
    });
  }

  private async captureAndCallback(userManagerCallback: () => Promise<User>, catchCallback?: () => Promise<any>, capturedCallback?: () => Promise<any>) {
    await this.awaitInit;
    const captured = (await this.userLoadedCapture.start());
    try {
      await userManagerCallback();
      await captured.toPromise();
      if (capturedCallback)
        await capturedCallback();
    } catch (error) {
      captured.release();
      if (catchCallback)
        return catchCallback();
    }
  }

  private async doSafeUserAction<T>(lock: Mutex, action: () => T): Promise<PromiseReturn<T>> {
    await this.awaitInit;
    const release = await lock.acquire();
    try {
      const a = await action();
      release();
      return <PromiseReturn<T>>a;
    } catch (error) {
      release();
      throw error;
    }
  }
}

type PromiseReturn<T> = T extends Promise<infer U> ? U : T;