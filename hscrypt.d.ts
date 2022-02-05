export declare function inject(src: string, pswd: string): Promise<void>;
export declare function encrypt({ source, pswd, iterations, }: {
    source: string;
    pswd: string;
    iterations?: number;
}): Uint8Array;
export declare function decrypt({ encrypted, pswd, iterations, }: {
    encrypted: Uint8Array;
    pswd: string;
    iterations?: number;
}): string;
