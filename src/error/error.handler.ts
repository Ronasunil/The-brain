import { Request, Response } from "express";
import httpStatusCodes from "http-status-codes"
import { AppError } from "./app-error";



const handleInvalidRoutes = async function(req:Request, res:Response) {

    const msg = `Route you requested does not exist: ${req.method} ${req.originalUrl}`
    const error = new AppError(msg, httpStatusCodes.NOT_FOUND).formatErrors()
    res.status(error[0].statusCode).json(error)
}


const globalErrorHandler = async function(err:Error, _req:Request, res:Response) {


    if (err instanceof AppError) {
        const error = err.formatErrors()
        res.status(error[0].statusCode).json(error)
    } else {
        console.error("Unhandled error:", err)
        res.status(httpStatusCodes.INTERNAL_SERVER_ERROR).json({
            status: httpStatusCodes.INTERNAL_SERVER_ERROR,
            data: null,
            message: "Internal Server Error"
        })
    }
}

export { globalErrorHandler, handleInvalidRoutes }


