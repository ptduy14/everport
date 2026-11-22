// The few Cloudflare APIs the relay uses, declared by hand. @cloudflare/workers-types would clash with the Node
// types that the rest of the repo needs (both declare Request, Response, WebSocket...).
// No top-level import: that would turn this into a module augmentation instead of an ambient declaration.
declare module 'cloudflare:workers' {
  export class DurableObject<Env = import('./platform.js').RelayEnv> {
    ctx: import('./platform.js').DurableObjectStateLike;
    env: Env;
    constructor(ctx: import('./platform.js').DurableObjectStateLike, env: Env);
  }
}
