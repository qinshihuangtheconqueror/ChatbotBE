import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { AuthService } from '@/server/services/auth.service';
import { LoginDto } from '@/server/dtos/login.dto';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('AuthController');

@Controller('v1/auth')
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    /** POST /v1/auth/login — eHUST student_id + password */
    @Post('login')
    @HttpCode(200)
    async login(@Body() body: LoginDto) {
        logger.info('Login attempt', { studentId: body.student_id });
        const result = await this.authService.login(body.student_id, body.password);
        return { status: 1, result };
    }

    /** POST /v1/auth/demo-login — email + password → studentId + JWT */
    @Post('demo-login')
    @HttpCode(200)
    async demoLogin(@Body() body: { email: string; password: string }) {
        logger.info('Demo login attempt', { email: body.email });
        const result = await this.authService.demoLogin(body.email, body.password);
        return { status: 1, result };
    }

    /** POST /v1/auth/microsoft-login — exchange MS auth code for JWT */
    @Post('microsoft-login')
    @HttpCode(200)
    async microsoftLogin(@Body() body: { code: string; redirectUri: string }) {
        logger.info('Microsoft login attempt');
        const result = await this.authService.microsoftLogin(body.code, body.redirectUri);
        return { status: 1, result };
    }
}
