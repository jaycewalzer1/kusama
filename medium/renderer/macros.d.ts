// Types for macro expansion. The implementation is macros.js, shared with the browser.

export declare class MacroError extends Error {}
export declare function expandMacro(node: any, pack: any): { part: string; node: any }[];
