export declare const getFontBasicMetrics: () => Record<string, { ascent: number; descent: number; capHeight: number; xHeight?: number }>
export declare const getMetrics: () => Record<string, number | (() => Record<string, number>)>
