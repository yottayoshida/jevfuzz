import release from '../package.json' with { type: 'json' };

export const TOOL_VERSION: string = release.version;
