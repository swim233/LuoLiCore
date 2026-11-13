import { createContext, useContext } from 'react';

/* 「变量」一节里：分组里登记了、tokens.css 里却没有的变量名（写错了或已经删了）。那一格标红，写「tokens.css 里没有这个变量」 */
export const MissingCtx = createContext<ReadonlySet<string>>(new Set());
export const useIsMissing = (name: string) => useContext(MissingCtx).has(name);
export const MISSING_TEXT = 'tokens.css 里没有这个变量';
