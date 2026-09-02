/**
 * Narrow compatibility declaration for Effect 4 RC declarations compiled in
 * the Node-only TS profile with skipLibCheck=false.
 *
 * Node 26 provides TextDecoder at runtime and @types/node exposes the options
 * under node:util, while Effect 4.0.0-rc.112 references the standard Web API
 * options as a global type. Keep this surface intentionally minimal instead of
 * adding the complete DOM library to backend projects.
 *
 * Remove after the pinned Effect release no longer requires the global type.
 */
interface TextDecoderOptions {
  readonly fatal?: boolean;
  readonly ignoreBOM?: boolean;
}
