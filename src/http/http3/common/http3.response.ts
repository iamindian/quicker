import { Http3HeaderFrame, Http3DataFrame } from "./frames";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

export class Http3Response {
    private ready: boolean = false;
    private content?: Buffer;
    private filePath?: string;
    private headers: {[property: string]: string} = {};
    // -> Content-Type
    
    public toBuffer(): Buffer {
        const headerFrame: Http3HeaderFrame = new Http3HeaderFrame(this.headers);
        
        let buffer: Buffer = headerFrame.toBuffer();

        if (this.filePath !== undefined) {
            let absoluteFilePath = this.parsePath(resolve(__dirname) + "/../../../../public" + this.filePath);
            console.debug("DEBUG: Filepath: ", absoluteFilePath);
            if (!existsSync(absoluteFilePath)) {
                absoluteFilePath = resolve(__dirname) + "/../../../../public/notfound.html";
            }
            
            const dataFrame: Http3DataFrame = new Http3DataFrame(readFileSync(absoluteFilePath));
            buffer = Buffer.concat([buffer, dataFrame.toBuffer()]);
            
        } else if (this.content !== undefined) {
            const dataFrame: Http3DataFrame = new Http3DataFrame(this.content);
            buffer = Buffer.concat([buffer, dataFrame.toBuffer()]);
        }
        
        return buffer;
    }

    public sendFile(path: string): boolean {
        // Can only send something when no other content has been buffered
        if (this.ready === true) {
            return false;
        }
        this.filePath = path;
        this.ready = true;
        
        // TODO Set content type header
        
        return true;
    }
    
    public send(content: Buffer): boolean {
        // Can only send something when no other content has been buffered
        if (this.content !== undefined || this.filePath != undefined) {
            return false;
        }
        this.content = content;
        this.ready = true;
        
        // TODO Set content type header
        
        return true;
    }
    
    public setHeaderValue(property: string, value: string) {
        this.headers[property] = value;
    }
    
    // TODO public setHeader(headerName: string, value: string) {}
    
    public isReady(): boolean {
        return this.ready;
    }
    
    public getContent(): Buffer | undefined {
        return this.content;
    }
    
    public getFilePath(): string | undefined {
        return this.filePath;
    }
    
    private parsePath(path: string): string {
        if (path.endsWith("/")) {
            return path + "index.html";
        } else {
            return path;
        }
    }
}