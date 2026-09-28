// Observación exclusiva de pruebas. Los ejecutables no se modifican ni se simulan HTTP o disponibilidad.
import { Server } from 'node:net';

const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object') process.send?.({ port: address.port });
  });
  return Reflect.apply(listen, this, args);
};

// En Windows, kill(SIGTERM) termina el proceso incondicionalmente. Un puente IPC
// ejercita los mismos manejadores; la CI POSIX envía señales reales del sistema operativo.
process.on('message', (message) => {
  if (
    process.platform === 'win32' &&
    (message?.signal === 'SIGTERM' || message?.signal === 'SIGINT')
  ) {
    process.emit(message.signal);
  }
  if (message?.fault === 'double-signal') {
    process.emit('SIGTERM');
    process.emit('SIGINT');
  }
  if (message?.fault === 'exception') throw new Error('synthetic-private-fault');
  if (message?.fault === 'rejection') void Promise.reject(new Error('synthetic-private-fault'));
});
process.channel?.unref();
