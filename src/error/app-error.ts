class AppError extends CustomError {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = "AppError";
    }

    formatErrors() {
        return [{ message: this.message, statusCode: this.statusCode }];
    }
}

export { AppError };