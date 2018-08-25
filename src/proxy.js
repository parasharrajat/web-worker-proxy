/* @flow */

import {
  ACTION_OPERATION,
  ACTION_DISPOSE,
  RESULT_SUCCESS,
  RESULT_ERROR,
  RESULT_CALLBACK,
  TYPE_FUNCTION,
} from './constants';
import type { Worker } from './types';

const proxies = new WeakMap();

/**
 * Proxies an object inside an worker.
 * This should be called inside an worker.
 */
export default function proxy(o: Object, target?: Worker = self) {
  if (proxies.has(target)) {
    throw new Error(
      'The specified target already has a proxy. To create a new proxy, call `dispose` first to dispose the previous proxy.'
    );
  }

  proxies.set(target, o);

  // Create an error response
  // Since we cannot send the error object, we send necessary info to recreate it
  const error = e => ({
    name: e.constructor.name,
    message: e.message,
    stack: e.stack,
  });

  // Listen to messages from the client
  const listener = (e: any) => {
    // List of persisted function refs
    const persisted = [];

    switch (e.data.type) {
      case ACTION_OPERATION:
        {
          const { id, data } = e.data;

          try {
            let result: any = o;

            for (const action of data) {
              if (action.type === 'get') {
                result = result[action.key];
              } else if (action.type === 'set') {
                // Reflect.set will return a boolean to indicate if setting the property was successful
                // Setting the property might fail if the object is read only
                result = Reflect.set(result, action.key, action.value);
              } else if (action.type === 'apply') {
                const prop = result[action.key];

                if (typeof prop !== 'function') {
                  throw new TypeError(`${data.key} is not a function`);
                } else {
                  result = prop(
                    // Loop through the results to find if there are callback functions
                    ...action.args.map(arg => {
                      if (
                        typeof arg === 'object' &&
                        arg != null &&
                        arg.type === TYPE_FUNCTION
                      ) {
                        // If we find a ref for a function, replace it with a custom function
                        // This function can notify the parent when it receives arguments
                        return (() => {
                          let called = false;

                          if (arg.persisted) {
                            // If the function is persisted, add it to the persisted list
                            persisted.push(arg.ref);
                          }

                          return (...params) => {
                            if (called && !persisted.includes(arg.ref)) {
                              // If function was called before and is no longer persisted, don't send results back
                              throw new Error(
                                'Callback has been disposed and no longer available.'
                              );
                            }

                            called = true;
                            target.postMessage({
                              type: RESULT_CALLBACK,
                              id,
                              func: {
                                args: params,
                                ref: arg.ref,
                              },
                            });
                          };
                        })();
                      }

                      return arg;
                    })
                  );
                }
              } else {
                throw new Error(`Unsupported operation ${action.type}`);
              }
            }

            // If result is a thenable, resolve the result before sending
            // This allows us to support results which are promise-like
            /* $FlowFixMe */
            if (result && typeof result.then === 'function') {
              Promise.resolve(result).then(
                r =>
                  target.postMessage({ type: RESULT_SUCCESS, id, result: r }),
                e =>
                  target.postMessage({
                    type: RESULT_ERROR,
                    id,
                    error: error(e),
                  })
              );
            } else {
              target.postMessage({ type: RESULT_SUCCESS, id, result });
            }
          } catch (e) {
            target.postMessage({
              type: RESULT_ERROR,
              id,
              error: error(e),
            });
          }
        }

        break;

      case ACTION_DISPOSE:
        {
          // Remove the callback ref from persisted list when it's disposed
          const index = persisted.indexOf(e.data.ref);

          if (index > -1) {
            persisted.slice(index, 1);
          }
        }

        break;
    }
  };

  target.addEventListener('message', listener);

  return {
    // Return a method to dispose the proxy
    // Disposing will remove the listeners and the proxy will stop working
    dispose: () => {
      target.removeEventListener('message', listener);
      proxies.delete(target);
    },
  };
}