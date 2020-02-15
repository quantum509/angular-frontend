export class ApiService {
    static get(baseUrl: string, path: string, headers?: { [key: string]: string }) {
        let url: string = ApiService.join(baseUrl, path);
        return new Promise(function (resolve, reject) {
            let xhr = new XMLHttpRequest();
            xhr.open("GET", url);
            if (headers) {
                for (const key in headers) {
                    xhr.setRequestHeader(key, headers[key]);
                }
            }
            xhr.onload = function () {
                if (this.status >= 200 && this.status < 300) {
                    let response = xhr.response;
                    if (response && ((<any>response).error || (<any>response).errorMessage)) {
                        reject({
                            status: this.status,
                            statusText: (((<any>response).error || (<any>response).errorMessage))
                        });
                    } else {
                        resolve(xhr.response);
                    }
                } else {
                    reject({
                        status: this.status,
                        statusText: xhr.statusText
                    });
                }
            };
            xhr.onerror = function () {
                reject({
                    status: this.status,
                    statusText: xhr.statusText
                });
            };
            xhr.send();
        });
    }

    static join(baseURL: string, path: string): string {
        let url: string = baseURL;
        if ("/" !== url.slice(-1) && "/" !== path[0]) { url += "/"; } // paths are constrained to within baseURL, so beginnig with "/" are not absolute
        url += path;
        return url;
    }
}
