import * as querystring from 'querystring'; // see https://nodejs.org/api/querystring.html#querystring_querystring_parse_str_sep_eq_options

export class ModeService {
    private initial_href: string; // original href before angular strips query and rewrites fragment
    private query_string: string; // query string from original href
    private _query: any; // query decoded from original href
    private query_used: any; // query parameter keys used within modeService
    private query_unused: any; // query parameter keys not used within modeService
    private query_login: string; // login-related items from query string
    private baseUrl: string; // original href with fragment and query removed
    private fragment: string; // fragment from original href
    private segment: string; // last segment of fragment from original href
    private suffix: string; // suffix on last segment of fragment from original href
    private baseFragment: string; // fragment from original href with suffix removed
    private fullUrl: string; // rebuilt canonical URL corresponding to original href
    private _embedded: boolean = false; // embedded mode - pages do not have navigation, cannot logout
    private _silent: boolean = false;  // silent mode - callback from silent login
    private _login: "NONE" | "INFO" | "STATUS" | "FAILED";   // not actually a mode - indicates login query was given
    private _iframe: boolean = false;  // not actually a mode - indicates page is loaded in an iframe
    private _depth: number = NaN;  // iframe nesting level
    private _mode: string; // general mode of this invocation

    constructor() {
        this.initial_href = window.location.href; // TODO: change back to injecting this as soon as that's supported by `ionic build --prod`
        this._iframe = (parent !== window);
        if (!this._iframe) {
            this._depth = 0;
        } else {
            let depth: number = 0;
            let next: any = window;
            while (next.parent !== next) {
                next = next.parent;
                depth += 1;
            }
            this._depth = depth;
        }

        this._dissect_initial_href();
        this._detect_silent();
        this._detect_embedded();
        this._detect_login();
        this._set_mode();
        this._query_unused();
        this._generate_href();
        this._reload();
    }

    private _dissect_initial_href() {
        let query_delimiter: number = this.initial_href.indexOf("?");
        if (query_delimiter <= -1) { query_delimiter = this.initial_href.indexOf("&"); }
        let fragment_delimiter: number = this.initial_href.indexOf("#");
        let base_delimiter = Math.min(...[this.initial_href.length, fragment_delimiter, query_delimiter].filter(n => n > 0));
        this.baseUrl = this.initial_href.slice(0, base_delimiter);
        if (query_delimiter > -1) {
            let query_start = query_delimiter + 1;
            let query_end = this.initial_href.length;
            if (fragment_delimiter >= query_start) { query_end = fragment_delimiter; }
            this.query_string = this.initial_href.slice(query_start, query_end);
            this._query = querystring.parse(this.query_string);
            this.query_used = {};
            this.query_unused = {};
        }
        if (fragment_delimiter > -1) {
            let fragment_start = fragment_delimiter + 1;
            let fragment_end = this.initial_href.length;
            if (query_delimiter >= fragment_start) { fragment_end = query_delimiter; }
            this.fragment = this.initial_href.slice(fragment_start, fragment_end);
            let segment_delimiter = this.fragment.lastIndexOf("/"); // this should never return -1, but if it does the segment will start at 0
            let segment_start = segment_delimiter + 1;
            this.segment = this.fragment.slice(segment_start);
            let suffix_delimiter = this.segment.lastIndexOf("-");
            if (suffix_delimiter > -1) {
                let suffix_start = suffix_delimiter + 1;
                this.suffix = this.segment.slice(suffix_start);
                let baseSegment: string = this.segment.slice(0, suffix_delimiter);
                let fragmentPrefix: String = this.fragment.slice(0, segment_start);
                this.baseFragment = fragmentPrefix + baseSegment;
            } else {
                this.baseFragment = this.fragment;
            }
        }

    }

    private _detect_silent() {
        if (this._query && this._query.mode === "silent") {
            this._silent = true;
            this.query_used.mode = true;
        }
    }

    private _detect_embedded() {
        if (this.segment === "embedded") { this._embedded = true; }
        if (this.suffix === "embedded") { this._embedded = true; }
        if (this._query) {
            if (this._query.embedded || "" === this._query.embedded) {
                this._embedded = true;
                this.query_used["embedded"] = true;  // Typescript 2.0 thinks property embedded does not exist on type {}
            }
        }
    }

    private _detect_login() {
        if (this._query) {
            const login_keys = ["session_state", "scope", "state", "expires_in", "token_type", "id_token", "access_token"];
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
                this._login = "INFO";
                if (this._query.mode === "redirect") { this.query_used.mode = true; }
                this.query_login = querystring.stringify(login);
            } else {
                const status_keys = ["session_state", "scope", "state", "id_token"];
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
                    this._login = "STATUS";
                    if (this._query.mode === "redirect") { this.query_used.mode = true; }
                    this.query_login = querystring.stringify(login);
                }
            }
        }
    }

    private _set_mode() {
        if (this._silent) {
            this._mode = "silent";
        } else if (this._embedded) {
            this._mode = "embedded";
        } else if (this._login === "INFO") {
            this._mode = "login";
        } else {
            this._mode = "normal";
        }
    }

    private _query_unused() {
        if (this._query) {
            let unused: any = {};
            for (let key in this._query) {
                if (!this.query_used[key]) {
                    let value: string = this._query[key];
                    unused[key] = value;
                }
            }
            this.query_unused = unused;
        }
    }

    private _generate_href() {
        let url: string = this.baseUrl;
        let minQuery: any;
        if (this._query) {
            minQuery = Object.assign({}, this._query); // { ...this._query }; // shallow copy
        }
        if (this.baseFragment) { url += "#" + this.baseFragment; }
        if (this._embedded && this.segment !== "embedded") {
            url += "/embedded";
            if (minQuery) { delete minQuery.embedded; }
        }
        if (minQuery) {
            let qstr = querystring.stringify(minQuery);
            if (qstr && qstr !== "") { url += "?" + qstr; }
        }
        this.fullUrl = url;
    }

    private _reload() {
        let reload: boolean = false;
        if (!this._silent && this._embedded) {
            if (this._query && (this._query.embedded || "" === this._query.embedded)) { reload = true; }  // todo: elvisize
            else if ("embedded" === this.suffix) { reload = true; }
        }
        if (reload) {
            window.location.href = this.fullUrl;
            window.location.reload();
        }
    }

    get embedded(): boolean { return this._embedded; }
    get silent(): boolean { return this._silent; }
    get login(): string { return this._login; }
    get iframe(): boolean { return this._iframe; }
    get url(): string { return this.fullUrl; }
    get url_segment(): string { return this.segment; }
    get login_query(): string { return this.query_login; }
    get depth(): number { return this._depth; }
    get mode(): string { return this._mode; }

    public query(key: string): string | undefined {
        let value: string | undefined;
        if (this._query) { value = this._query[key]; }
        return value;
    }

    public static get depth(): number {
        let depth: number = 0;
        let in_iframe = (parent !== window);
        if (in_iframe) {
            let next: Window = window;
            while (next.parent !== next) {
                next = next.parent;
                depth += 1;
            }
        }
        return depth;
    }

}
