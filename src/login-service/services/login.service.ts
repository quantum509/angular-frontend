import { UserManager, User, UserManagerSettings, UserManagerEvents } from 'oidc-client';
import { Subscription, Subject } from 'rxjs';

import { Mutex } from 'async-mutex';

// import { ModeService } from "../services/mode.service";
import { Injectable } from '@angular/core';
import * as querystring from 'querystring'; // see https://nodejs.org/api/querystring.html#querystring_querystring_parse_str_sep_eq_options


export class ModeService {
  private initial_href: string; // original href before angular strips query and rewrites fragment
  private query_string: string; // query string from original href
  private _query: any; // query decoded from original href
  private query_used: any; // query parameter keys used within modeService
  private query_login: string; // login-related items from query string
  private fragment: string; // fragment from original href
  private segment: string; // last segment of fragment from original href
  private fullUrl: string; // rebuilt canonical URL corresponding to original href
  private _silent: boolean = false;  // silent mode - callback from silent login
  private _login: 'NONE' | 'INFO' | 'STATUS' | 'FAILED';   // not actually a mode - indicates login query was given
  private _iframe: boolean = false;  // not actually a mode - indicates page is loaded in an iframe
  private _mode: string; // general mode of this invocation

  constructor() {
      this.initial_href = window.location.href; // TODO: change back to injecting this as soon as that's supported by `ionic build --prod`
      this._iframe = (parent !== window);
      this._dissect_initial_href();
      this._detect_silent();
      this._detect_login();
      this._set_mode();
      this._reload();
  } 
  private _dissect_initial_href() {
      let query_delimiter: number = this.initial_href.indexOf('?');
      if (query_delimiter <= -1) { query_delimiter = this.initial_href.indexOf('&'); }
      let fragment_delimiter: number = this.initial_href.indexOf('#');
      if (query_delimiter > -1) {
          let query_start = query_delimiter + 1;
          let query_end = this.initial_href.length;
          if (fragment_delimiter >= query_start) { query_end = fragment_delimiter; }
          this.query_string = this.initial_href.slice(query_start, query_end);
          this._query = querystring.parse(this.query_string);
          this.query_used = {};
      }
      if (fragment_delimiter > -1) {
          let fragment_start = fragment_delimiter + 1;
          let fragment_end = this.initial_href.length;
          if (query_delimiter >= fragment_start) { fragment_end = query_delimiter; }
          this.fragment = this.initial_href.slice(fragment_start, fragment_end);
          let segment_delimiter = this.fragment.lastIndexOf('/'); // this should never return -1, but if it does the segment will start at 0
          let segment_start = segment_delimiter + 1;
          this.segment = this.fragment.slice(segment_start);
          // let suffix_delimiter = this.segment.lastIndexOf("-");
      }

  }
  private _detect_silent() {
      if (this._query && this._query.mode === 'silent') {
          this._silent = true;
          this.query_used.mode = true;
      }
  }

  private _detect_login() {
      if (this._query) {
          const login_keys = ['session_state', 'scope', 'state', 'expires_in', 'token_type', 'id_token', 'access_token'];
          let login: any = {};
          let missing: boolean = false;
          for (let key of login_keys) {
              let value: string = this._query[key];
              if (!value) {
                  missing = true;
                  break;
              }
          }
          if (!missing) {
              for (let key of login_keys) {
                  let value: string = this._query[key];
                  login[key] = value;
                  this.query_used[key] = true; // second loop required to do this after checking for missing
              }
              this._login = 'INFO';
              if (this._query.mode === 'redirect') { this.query_used.mode = true; }
              this.query_login = querystring.stringify(login);
          } else {
              const status_keys = ['session_state', 'scope', 'state', 'id_token'];
              login = {};
              missing = false;
              for (let key of status_keys) {
                  let value: string = this._query[key];
                  if (!value) {
                      missing = true;
                      break;
                  }
              }
              if (!missing) {
                  for (let key of status_keys) {
                      let value: string = this._query[key];
                      login[key] = value;
                      this.query_used[key] = true; // second loop required to do this after checking for missing
                  }
                  this._login = 'STATUS';
                  if (this._query.mode === 'redirect') { this.query_used.mode = true; }
                  this.query_login = querystring.stringify(login);
              }
          }
      }
  }

  private _set_mode() {
      if (this._silent) {
          this._mode = 'silent';
      } else if (this._login === 'INFO') {
          this._mode = 'login';
      } else {
          this._mode = 'normal';
      }
  }

  private _reload() {
      let reload: boolean = false;
      if (reload) {
          window.location.href = this.fullUrl;
          window.location.reload();
      }
  }

  get silent(): boolean { return this._silent; }
  get login(): string { return this._login; }
  get iframe(): boolean { return this._iframe; }
  get url(): string { return this.fullUrl; }
  get url_segment(): string { return this.segment; }
  get login_query(): string { return this.query_login; }
  get mode(): string { return this._mode; }
  

}
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
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.bearerToken
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
      this.mgr.events.addAccessTokenExpired(() => this.onUserUnloaded('UserManager emitted AccessTokenExpired'));
      this.mgr.events.addUserUnloaded(() => this.onUserUnloaded('UserManager emitted UserUnloaded'));
      this.initializeEvent();
      return this.processMode();
    } else if (loginConfig === this.loginConfig) {
      return Promise.resolve();
    } else {
      return Promise.reject(new Error('Cannot Initialize loginService More Than Once!'));
    }
  }

  private processMode() {
    return this.doSafeUserAction(this.publicLock, () => {
      switch (this.modeService.mode) {
        case 'silent':  // Process silent redirect, no fallback
          return this.doSafeUserAction(this.privateLock, () => this.mgr.signinSilentCallback(this.modeService.login_query));
        case 'login':  // Process login redirect, fallback on recovery
          return this.doSafeUserAction(this.privateLock, () => this.mgr.signinRedirectCallback(this.modeService.login_query)).catch(() => this.logInSilent());
        case 'normal':
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
      .then(() => this.getUserOrFail(('User recovered to ' + this.currentUser)))
      .catch((err: any) => {
        return this.logInInteractive(stateinfo)
          .then(() => this.getUserOrFail(('Interactive login resolved to ' + this.currentUser)));
      });
  }

  public get checkUser(): boolean {
    return !!this.currentUser && !this.currentUser.expired;
  }

  private recoverUser(): Promise<User> {
    return this.logInSilent()
      .then(() => this.getUserOrFail(('Silent login resolved to ' + this.currentUser)));
  }

  private logInInteractive(stateinfo?: string | undefined): Promise<User> {
    return this.logInRedirect(stateinfo)
      .then(() => this.getUserOrFail(('Redirect login resolved to ' + this.currentUser)));
  }

  private logInRedirect(stateinfo?: string | undefined): Promise<User | void> {
    let stateobj: any = stateinfo ? { state: stateinfo } : undefined; // TODO: don't use type anyInjectable
    
    return this.doSafeUserAction(this.privateLock, () => this.mgr.signinRedirect(stateobj))
      .catch(() => this.getUserOrFail('Redirect login resolved to ' + this.currentUser));
  }

  private logInSilent(): Promise<User> {
    if (this.modeService.silent)
      return Promise.reject('recursive silent login requested in silent mode.');

    return this.doSafeUserAction(this.privateLock, () => this.mgr.signinSilent())
      .catch(() => this.getUserOrFail('Silent login resolved to ' + this.currentUser));
  }

  public logOut(): Promise<void> {
      return this.doSafeUserAction(this.publicLock, () => this.mgr.signoutRedirect().then(() => this.clearAuth()));
  }

  private onUserLoaded(user: User): void {
    if (!user) {
      this.userEvents.next(new Error('Invalid user (false) = ' + JSON.stringify(user)));
    } else if (user.expired) {
      this.userEvents.next(new Error('Invalid user (expired,' + user.expires_in + ')'));
    } else {
      this.doSafeUserAction(this.privateLock, () => {
        this.currentUser = user;
        this.userEvents.next(user);
      }).catch((err: Error) => {
        err.message = 'Failed while or after acquiring userLock -- ' + err.message;
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
      err.message = 'Failed while or after acquiring userLock -- ' + err.message;
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