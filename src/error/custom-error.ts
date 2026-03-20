export default abstract class CustomError extends Error {
    abstract statusCode: number;
    abstract formatErrors(): { message: string; field?: string }[];

    constructor(msg:string) {
        super(msg);
        this.name = "CustomError";
    }
}