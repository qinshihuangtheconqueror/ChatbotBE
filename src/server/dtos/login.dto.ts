import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class LoginDto {
    @IsString()
    @IsNotEmpty({ message: 'MSSV không được để trống' })
    student_id!: string;

    @IsString()
    @IsNotEmpty({ message: 'Mật khẩu không được để trống' })
    @MinLength(4, { message: 'Mật khẩu tối thiểu 4 ký tự' })
    password!: string;
}
