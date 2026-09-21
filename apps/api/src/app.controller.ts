import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('/health')
  public health(): { service: string; status: 'ok' } {
    return { service: 'qapaq-api', status: 'ok' };
  }
}
