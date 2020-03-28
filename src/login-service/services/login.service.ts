import { UserManager, User, UserManagerSettings, UserManagerEvents } from "oidc-client";
import { Subscription, Subject } from "rxjs";

import { Mutex } from "async-mutex";

import { ModeService } from "../services/mode.service";
import { Injectable } from "@angular/core";

@Injectable()
export class LoginService {
  static get DefaultUserManagerSettings(): UserManagerSettings {
    return {
      scope: 'openid profile gsupersonpantherid pantherCash',
      response_type: 'id_token token',
      automaticSilentRenew: true,
      monitorSession: false,
      filterProtocolClaims: false,
      loadUserInfo: false,
      revokeAccessTokenOnSignout: true,
      silentRequestTimeout: 11000
    };
  }

  private mgr: UserManager;
  private currentUser: User;

  private privateLock: Mutex = new Mutex();    // lock in (private) methods that set currentUser: clearAuth and onUserLoaded
  private publicLock: Mutex = new Mutex(); // lock in PUBLIC methods: constructor, getCurrentUser, getUserOrLogin, logOut -- ONLY INSIDE awaitInit

  private userEvents: Subject<User | Error> = new Subject<User | Error>();
  private userLoadedEvents: Subject<User> = new Subject<User>(); // userEvents filtered to emit only Users
  private userErrorEvents: Subject<Error> = new Subject<Error>(); // userEvents filtered to emit only Errors

  private loginConfig: UserManagerSettings;

  private initializeEvent: () => void;
  private awaitInit: Promise<void>;

  public modeService: ModeService;
  public get events(): UserManagerEvents | undefined { return this?.mgr.events; }
  public get isInitialized(): boolean { return !!this.mgr; }
  public get hasUser(): boolean { return !!this.currentUser; }
  public get userObject(): User | undefined { return this.currentUser; }
  public get oldState(): string { return this?.currentUser?.state; }
  public get bearerToken(): string | undefined { return this?.currentUser?.access_token; }
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

  public initialize(loginConfig: LoginConfig): Promise<void> {
    if (!this.loginConfig) {
      this.loginConfig = Object.assign({}, LoginService.DefaultUserManagerSettings, loginConfig);
      this.mgr = new UserManager(this.loginConfig);
      this.mgr.events.addUserLoaded((user: User) => this.onUserLoaded(user));
      this.mgr.events.addAccessTokenExpired(() => this.onUserUnloaded("UserManager emitted AccessTokenExpired"));
      this.mgr.events.addUserUnloaded(() => this.onUserUnloaded("UserManager emitted UserUnloaded"));
      this.initializeEvent();
      return this.processMode();
    } else if (loginConfig === this.loginConfig) {
      return Promise.resolve();
    } else {
      return Promise.reject(new Error("Cannot Initialize loginService More Than Once!"));
    }
  }

  private processMode() {
    return this.doSafeUserAction(this.publicLock, () => {
      switch (this.modeService.mode) {
        case "silent":  // Process silent redirect, no fallback
          return this.doSafeUserAction(this.privateLock, () => this.mgr.signinSilentCallback(this.modeService.login_query));
        case "login":  // Process login redirect, fallback on recovery
          return this.doSafeUserAction(this.privateLock, () => this.mgr.signinRedirectCallback(this.modeService.login_query)).catch(() => this.logInSilent());
        case "embedded":  // getOrRecover
        case "normal":
          return this.getOrRecoverUser();
      }
    })
      .catch(e => console.log(e))
      .then(() => { });
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
    return this.recoverUser()
      .then(() => this.getUserOrFail(("User recovered to " + this.currentUser)))
      .catch((err: any) => {
        return this.logInInteractive(stateinfo)
          .then(() => this.getUserOrFail(("Interactive login resolved to " + this.currentUser)));
      });
  }

  public get checkUser(): boolean {
    return !!this.currentUser && !this.currentUser.expired;
  }

  private recoverUser(): Promise<User> {
    return this.logInSilent()
      .then(() => this.getUserOrFail(("Silent login resolved to " + this.currentUser)));
  }

  private logInInteractive(stateinfo?: string | undefined): Promise<User> {
    if (this.modeService.embedded)
      return Promise.reject("This frame was unable to find your login session.");

    return this.logInRedirect(stateinfo)
      .then(() => this.getUserOrFail(("Redirect login resolved to " + this.currentUser)));
  }

  private logInRedirect(stateinfo?: string | undefined): Promise<User | void> {
    let stateobj: any = stateinfo ? { state: stateinfo } : undefined; // TODO: don't use type any
    if (this.modeService.embedded)
      return Promise.reject("This frame was unable to find your login session.");

    return this.doSafeUserAction(this.privateLock, () => this.mgr.signinRedirect(stateobj))
      .catch(() => this.getUserOrFail("Redirect login resolved to " + this.currentUser));
  }

  private logInSilent(): Promise<User> {
    if (this.modeService.silent)
      return Promise.reject("recursive silent login requested in silent mode.");

    return this.doSafeUserAction(this.privateLock, () => this.mgr.signinSilent())
      .catch(() => this.getUserOrFail("Silent login resolved to " + this.currentUser));
  }

  public logOut(): Promise<void> {
    if (this.modeService.embedded) {
      return Promise.reject("You must log out of the whole page, not just this frame.");
    } else {
      return this.doSafeUserAction(this.publicLock, () => this.mgr.signoutRedirect().then(() => this.clearAuth()));
    }
  }

  private onUserLoaded(user: User): void {
    if (!user) {
      this.userEvents.next(new Error("Invalid user (false) = " + JSON.stringify(user)));
    } else if (user.expired) {
      this.userEvents.next(new Error("Invalid user (expired," + user.expires_in + ")"));
    } else {
      this.doSafeUserAction(this.privateLock, () => {
        this.currentUser = user;
        this.userEvents.next(user);
      }).catch((err: Error) => {
        err.message = "Failed while or after acquiring userLock -- " + err.message;
        this.userEvents.next(err);
      });
    }
  }

  private onUserUnloaded(from: string): void {
    this.doSafeUserAction(this.privateLock, () => {
      if (this.currentUser) {
        delete this.currentUser;
        this.userEvents.next(undefined);
      }

    }).catch((err: Error) => {
      err.message = "Failed while or after acquiring userLock -- " + err.message;
      this.userEvents.next(err);
    });
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
export interface RequiredUserSettings {
  authority: string;
  client_id: string;
  redirect_uri: string;
  silent_redirect_uri: string;
  popup_redirect_uri: string;
  post_logout_redirect_uri: string;
}

export type LoginConfig = RequiredUserSettings & UserManagerSettings;