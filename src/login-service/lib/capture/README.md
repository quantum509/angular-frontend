# capture-lib

TypeScript library for capturing events as promises

Might be helpful when using a library where methods trigger events but neither return the event data nor a promise that resolves to the event data.

## Dependencies

Imports from [rxjs](https://www.npmjs.com/package/rxjs) and [prex](https://www.npmjs.com/package/prex):
```
import { Observable } from "rxjs/Observable";
import { Subscription } from "rxjs/Subscription";
import { ReaderWriterLock, LockHandle } from "prex";
```

## Gist of usage
Import:

```
import { Capture, Captured } from "path/to/capture.lib";
```

Setup:
```
    myCapture: Capture<EventType> = new Capture<EventType>( observableToCapture );
```

Capture triggered event:
```
    promise: Promise<EventType> = myCapture.start().then( (captured:Captured<EventType>) => {
        triggerEvent();
        return captured.toPromise();
    }
```
