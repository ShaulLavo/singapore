export const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

export const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff
