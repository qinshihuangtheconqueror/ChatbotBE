export class BaseError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly statusCode: number = 500,
    ) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class ValidationError extends BaseError {
    constructor(message: string) { super('INVALID_INPUT', message, 400); }
}

export class NotFoundError extends BaseError {
    constructor(message: string) { super('NOT_FOUND', message, 404); }
}

export class UnauthorizedError extends BaseError {
    constructor(message: string) { super('UNAUTHORIZED', message, 401); }
}

export class RateLimitError extends BaseError {
    constructor() { super('RATE_LIMITED', 'Too many requests', 429); }
}
