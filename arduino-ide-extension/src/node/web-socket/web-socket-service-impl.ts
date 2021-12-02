import { Emitter } from '@theia/core';
import { injectable } from 'inversify';
import * as WebSocket from 'ws';
import { WebSocketService } from './web-socket-service';

@injectable()
export default class WebSocketServiceImpl implements WebSocketService {
  protected wsClients: WebSocket[];
  protected server: WebSocket.Server;

  protected readonly onMessage = new Emitter<string>();
  public readonly onMessageReceived = this.onMessage.event;

  protected readonly onConnectedClients = new Emitter<number>();
  public readonly onClientsNumberChanged = this.onConnectedClients.event;

  constructor() {
    this.wsClients = [];
    this.server = new WebSocket.Server({ port: 0 });

    const addClient = this.addClient.bind(this);
    this.server.on('connection', addClient);
  }

  private addClient(ws: WebSocket): void {
    this.wsClients.push(ws);
    this.onConnectedClients.fire(this.wsClients.length);

    ws.onclose = () => {
      this.wsClients.splice(this.wsClients.indexOf(ws), 1);
      this.onConnectedClients.fire(this.wsClients.length);
    };

    ws.onmessage = (res) => {
      this.onMessage.fire(res.data.toString());
    };
  }

  getConnectedClientsNumber(): number {
    return this.wsClients.length;
  }

  getAddress(): WebSocket.AddressInfo {
    return this.server.address() as WebSocket.AddressInfo;
  }

  sendMessage(message: string): void {
    this.wsClients.forEach((w) => {
      try {
        w.send(message);
      } catch {
        w.close();
      }
    });
  }
}
