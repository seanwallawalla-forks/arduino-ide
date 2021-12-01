import { injectable, inject } from 'inversify';
import { deepClone } from '@theia/core/lib/common/objects';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { MessageService } from '@theia/core/lib/common/message-service';
import {
  SerialService,
  SerialConfig,
  SerialError,
  Status,
  SerialServiceClient,
} from '../../common/protocol/serial-service';
import { BoardsServiceProvider } from '../boards/boards-service-provider';
import {
  Port,
  Board,
  BoardsService,
} from '../../common/protocol/boards-service';
import { BoardsConfig } from '../boards/boards-config';
import { SerialModel } from './serial-model';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { CoreService } from '../../common/protocol';
import { nls } from '@theia/core/lib/common/nls';

@injectable()
export class SerialConnectionManager {
  protected _state: Serial.State = [];
  protected config: Partial<SerialConfig> = {
    board: undefined,
    port: undefined,
    baudRate: undefined,
  };

  protected readonly onConnectionChangedEmitter = new Emitter<boolean>();

  /**
   * This emitter forwards all read events **if** the connection is established.
   */
  protected readonly onReadEmitter = new Emitter<{ messages: string[] }>();

  /**
   * Array for storing previous serial errors received from the server, and based on the number of elements in this array,
   * we adjust the reconnection delay.
   * Super naive way: we wait `array.length * 1000` ms. Once we hit 10 errors, we do not try to reconnect and clean the array.
   */
  protected serialErrors: SerialError[] = [];
  protected reconnectTimeout?: number;

  /**
   * When the websocket server is up on the backend, we save the port here, so that the client knows how to connect to it
   * */
  protected wsPort?: number;
  protected webSocket?: WebSocket;

  constructor(
    @inject(SerialModel) protected readonly serialModel: SerialModel,
    @inject(SerialService) protected readonly serialService: SerialService,
    @inject(SerialServiceClient)
    protected readonly serialServiceClient: SerialServiceClient,
    @inject(BoardsService) protected readonly boardsService: BoardsService,
    @inject(BoardsServiceProvider)
    protected readonly boardsServiceProvider: BoardsServiceProvider,
    @inject(MessageService) protected messageService: MessageService,
    @inject(ThemeService) protected readonly themeService: ThemeService,
    @inject(CoreService) protected readonly core: CoreService
  ) {
    this.serialServiceClient.onWebSocketChanged(
      this.handleWebSocketChanged.bind(this)
    );
    this.serialServiceClient.onBaudRateChanged((baudRate) => {
      if (this.serialModel.baudRate !== baudRate) {
        this.serialModel.baudRate = baudRate;
      }
    });
    this.serialServiceClient.onLineEndingChanged((lineending) => {
      if (this.serialModel.lineEnding !== lineending) {
        this.serialModel.lineEnding = lineending;
      }
    });
    this.serialServiceClient.onInterpolateChanged((interpolate) => {
      if (this.serialModel.interpolate !== interpolate) {
        this.serialModel.interpolate = interpolate;
      }
    });

    this.serialServiceClient.onError(this.handleError.bind(this));
    this.boardsServiceProvider.onBoardsConfigChanged(
      this.handleBoardConfigChange.bind(this)
    );

    // Handles the `baudRate` changes by reconnecting if required.
    this.serialModel.onChange(async ({ property }) => {
      if (
        property === 'baudRate' &&
        (await this.serialService.isSerialPortOpen())
      ) {
        const { boardsConfig } = this.boardsServiceProvider;
        this.handleBoardConfigChange(boardsConfig);
      }

      // update the current values in the backend and propagate to websocket clients
      this.serialService.updateWsConfigParam({
        ...(property === 'lineEnding' && {
          currentLineEnding: this.serialModel.lineEnding,
        }),
        ...(property === 'interpolate' && {
          interpolate: this.serialModel.interpolate,
        }),
      });
    });

    this.themeService.onDidColorThemeChange((theme) => {
      this.serialService.updateWsConfigParam({
        darkTheme: theme.newTheme.type === 'dark',
      });
    });
  }

  /**
   * Set the config passing only the properties that has changed. If some has changed and the serial is open,
   * we try to reconnect
   *
   * @param newConfig the porperties of the config that has changed
   */
  async setConfig(newConfig: Partial<SerialConfig>): Promise<void> {
    let configHasChanged = false;
    Object.keys(this.config).forEach((key: keyof SerialConfig) => {
      if (newConfig[key] !== this.config[key]) {
        configHasChanged = true;
        this.config = { ...this.config, [key]: newConfig[key] };
      }
    });
    if (
      configHasChanged &&
      this.widgetsAttached() &&
      !(await this.core.isUploading())
    ) {
      this.serialService.updateWsConfigParam({
        currentBaudrate: this.config.baudRate,
        serialPort: this.config.port?.address,
      });
      await this.disconnect();
      await this.connect();
    }
  }

  getConfig(): Partial<SerialConfig> {
    return this.config;
  }

  getWsPort(): number | undefined {
    return this.wsPort;
  }

  isWebSocketConnected(): boolean {
    return !!this.webSocket?.url;
  }

  protected handleWebSocketChanged(wsPort: number): void {
    this.wsPort = wsPort;
  }

  /**
   * When the serial is open and the frontend is connected to the serial, we create the websocket here
   */
  protected createWsConnection(): boolean {
    if (this.wsPort) {
      try {
        this.webSocket = new WebSocket(`ws://localhost:${this.wsPort}`);
        this.webSocket.onmessage = (res) => {
          const messages = JSON.parse(res.data);
          this.onReadEmitter.fire({ messages });
        };
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Sets the types of connections needed by the client.
   *
   * @param newState The array containing the list of desired connections.
   *          If the previuos state was empty and 'newState' is not, it tries to reconnect to the serial service
   *          If the provios state was NOT empty and now it is, it disconnects to the serial service
   * @returns The status of the operation
   */
  protected async setState(newState: Serial.State): Promise<Status> {
    const oldState = deepClone(this._state);
    let status = Status.OK;

    if (this.widgetsAttached(oldState) && !this.widgetsAttached(newState)) {
      status = await this.disconnect();
    } else if (
      !this.widgetsAttached(oldState) &&
      this.widgetsAttached(newState)
    ) {
      if (await this.core.isUploading()) {
        this.messageService.error(`Cannot open serial port when uploading`);
        return Status.NOT_CONNECTED;
      }
      status = await this.connect();
    }
    this._state = newState;
    return status;
  }

  protected get state(): Serial.State {
    return this._state;
  }

  widgetsAttached(state?: Serial.State): boolean {
    return (state ? state : this._state).length > 0;
  }

  get serialConfig(): SerialConfig | undefined {
    return isSerialConfig(this.config)
      ? (this.config as SerialConfig)
      : undefined;
  }

  async isBESerialConnected(): Promise<boolean> {
    return await this.serialService.isSerialPortOpen();
  }

  /**
   * Called when a client opens the serial from the GUI
   *
   * @param type could be either 'Monitor' or 'Plotter'. If it's 'Monitor' we also connect to the websocket and
   *             listen to the message events
   * @returns the status of the operation
   */
  async openSerial(type: Serial.Type): Promise<Status> {
    if (!isSerialConfig(this.config)) {
      this.messageService.error(
        `Please select a board and a port to open the serial connection.`
      );
      return Status.NOT_CONNECTED;
    }
    if (this.state.includes(type)) return Status.OK;
    const newState = deepClone(this.state);
    newState.push(type);
    const status = await this.setState(newState);
    if (Status.isOK(status) && type === Serial.Type.Monitor)
      this.createWsConnection();
    return status;
  }

  /**
   * Called when a client closes the serial from the GUI
   *
   * @param type could be either 'Monitor' or 'Plotter'. If it's 'Monitor' we close the websocket connection
   * @returns the status of the operation
   */
  async closeSerial(type: Serial.Type): Promise<Status> {
    const index = this.state.indexOf(type);
    let status = Status.OK;
    if (index >= 0) {
      const newState = deepClone(this.state);
      newState.splice(index, 1);
      status = await this.setState(newState);
      if (
        Status.isOK(status) &&
        type === Serial.Type.Monitor &&
        this.webSocket
      ) {
        this.webSocket.close();
        this.webSocket = undefined;
      }
    }
    return status;
  }

  /**
   * Handles error on the SerialServiceClient and try to reconnect, eventually
   */
  async handleError(error: SerialError): Promise<void> {
    if (!(await this.serialService.isSerialPortOpen())) return;
    const { code, config } = error;
    const { board, port } = config;
    const options = { timeout: 3000 };
    switch (code) {
      case SerialError.ErrorCodes.CLIENT_CANCEL: {
        console.debug(
          `Serial connection was canceled by client: ${Serial.Config.toString(
            this.config
          )}.`
        );
        break;
      }
      case SerialError.ErrorCodes.DEVICE_BUSY: {
        this.messageService.warn(
          nls.localize(
            'arduino/serial/connectionBusy',
            'Connection failed. Serial port is busy: {0}',
            Port.toString(port)
          ),
          options
        );
        this.serialErrors.push(error);
        break;
      }
      case SerialError.ErrorCodes.DEVICE_NOT_CONFIGURED: {
        this.messageService.info(
          nls.localize(
            'arduino/serial/disconnected',
            'Disconnected {0} from {1}.',
            Board.toString(board, {
              useFqbn: false,
            }),
            Port.toString(port)
          ),
          options
        );
        break;
      }
      case undefined: {
        this.messageService.error(
          nls.localize(
            'arduino/serial/unexpectedError',
            'Unexpected error. Reconnecting {0} on port {1}.',
            Board.toString(board),
            Port.toString(port)
          ),
          options
        );
        console.error(JSON.stringify(error));
        break;
      }
    }

    if (this.widgetsAttached()) {
      if (this.serialErrors.length >= 10) {
        this.messageService.warn(
          nls.localize(
            'arduino/serial/failedReconnect',
            'Failed to reconnect {0} to serial port after 10 consecutive attempts. The {1} serial port is busy.',
            Board.toString(board, {
              useFqbn: false,
            }),
            Port.toString(port)
          )
        );
        this.serialErrors.length = 0;
      } else {
        const attempts = this.serialErrors.length || 1;
        if (this.reconnectTimeout !== undefined) {
          // Clear the previous timer.
          window.clearTimeout(this.reconnectTimeout);
        }
        const timeout = attempts * 1000;
        this.messageService.warn(
          nls.localize(
            'arduino/serial/reconnect',
            'Reconnecting {0} to {1} in {2} seconds...',
            Board.toString(board, {
              useFqbn: false,
            }),
            Port.toString(port),
            attempts.toString()
          )
        );
        this.reconnectTimeout = window.setTimeout(
          () => this.connect(),
          timeout
        );
      }
    }
  }

  async connect(): Promise<Status> {
    if (await this.serialService.isSerialPortOpen())
      return Status.ALREADY_CONNECTED;
    if (!isSerialConfig(this.config)) return Status.NOT_CONNECTED;

    console.info(
      `>>> Creating serial connection for ${Board.toString(
        this.config.board
      )} on port ${Port.toString(this.config.port)}...`
    );
    const connectStatus = await this.serialService.connect(this.config);
    if (Status.isOK(connectStatus)) {
      console.info(
        `<<< Serial connection created for ${Board.toString(this.config.board, {
          useFqbn: false,
        })} on port ${Port.toString(this.config.port)}.`
      );
    }

    return Status.isOK(connectStatus);
  }

  async disconnect(): Promise<Status> {
    if (!(await this.serialService.isSerialPortOpen())) {
      return Status.OK;
    }

    console.log('>>> Disposing existing serial connection...');
    const status = await this.serialService.disconnect();
    if (Status.isOK(status)) {
      console.log(
        `<<< Disposed serial connection. Was: ${Serial.Config.toString(
          this.config
        )}`
      );
      this.wsPort = undefined;
    } else {
      console.warn(
        `<<< Could not dispose serial connection. Activate connection: ${Serial.Config.toString(
          this.config
        )}`
      );
    }

    return status;
  }

  /**
   * Sends the data to the connected serial port.
   * The desired EOL is appended to `data`, you do not have to add it.
   * It is a NOOP if connected.
   */
  async send(data: string): Promise<Status> {
    if (!(await this.serialService.isSerialPortOpen())) {
      return Status.NOT_CONNECTED;
    }
    return new Promise<Status>((resolve) => {
      this.serialService
        .sendMessageToSerial(data + this.serialModel.lineEnding)
        .then(() => resolve(Status.OK));
    });
  }

  get onConnectionChanged(): Event<boolean> {
    return this.onConnectionChangedEmitter.event;
  }

  get onRead(): Event<{ messages: string[] }> {
    return this.onReadEmitter.event;
  }

  protected async handleBoardConfigChange(
    boardsConfig: BoardsConfig.Config
  ): Promise<void> {
    const { selectedBoard: board, selectedPort: port } = boardsConfig;
    const { baudRate } = this.serialModel;
    const newConfig: Partial<SerialConfig> = { board, port, baudRate };
    this.setConfig(newConfig);
  }
}

export namespace Serial {
  export enum Type {
    Monitor = 'Monitor',
    Plotter = 'Plotter',
  }

  /**
   * The state represents which types of connections are needed by the client, and it should match whether the Serial Monitor
   * or the Serial Plotter are open or not in the GUI. It's an array cause it's possible to have both, none or only one of
   * them open
   */
  export type State = Serial.Type[];

  export namespace Config {
    export function toString(config: Partial<SerialConfig>): string {
      if (!isSerialConfig(config)) return '';
      const { board, port } = config;
      return `${Board.toString(board)} ${Port.toString(port)}`;
    }
  }
}

function isSerialConfig(config: Partial<SerialConfig>): config is SerialConfig {
  return !!config.board && !!config.baudRate && !!config.port;
}
