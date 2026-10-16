/** The same keys as `T`, any text: each translation must cover the reference exactly. */
export type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };
