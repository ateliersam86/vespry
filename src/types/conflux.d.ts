/**
 * Déclarations de types pour `@transcend-io/conflux` (le paquet n'en fournit
 * pas). On ne déclare que l'API Writer qu'on utilise pour streamer le zip.
 */
declare module '@transcend-io/conflux' {
  export interface ZipEntry {
    name: string;
    lastModified?: Date;
    stream: () => ReadableStream;
  }

  export class Writer {
    constructor();
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<ZipEntry>;
  }

  export class Reader {
    constructor(file: Blob | ReadableStream);
  }
}
