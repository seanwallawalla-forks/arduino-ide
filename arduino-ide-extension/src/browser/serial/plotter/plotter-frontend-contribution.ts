import { ThemeService } from '@theia/core/lib/browser/theming';
import { injectable, inject } from 'inversify';
import {
  Command,
  CommandRegistry,
  MaybePromise,
  MenuModelRegistry,
} from '@theia/core';
import { SerialModel } from '../serial-model';
import { ArduinoMenus } from '../../menu/arduino-menus';
import { Contribution } from '../../contributions/contribution';
import { Endpoint, FrontendApplication } from '@theia/core/lib/browser';
import { ipcRenderer } from '@theia/core/shared/electron';
import { SerialConfig, Status } from '../../../common/protocol';
import { Serial, SerialConnectionManager } from '../serial-connection-manager';
import { SerialPlotter } from './protocol';
import { BoardsServiceProvider } from '../../boards/boards-service-provider';
const queryString = require('query-string');

export namespace SerialPlotterContribution {
  export namespace Commands {
    export const OPEN: Command = {
      id: 'serial-plotter-open',
      label: 'Serial Plotter',
      category: 'Arduino',
    };
  }
}

@injectable()
export class PlotterFrontendContribution extends Contribution {
  protected window: Window | null;
  protected url: string;
  protected wsPort: number;

  @inject(SerialModel)
  protected readonly model: SerialModel;

  @inject(ThemeService)
  protected readonly themeService: ThemeService;

  @inject(SerialConnectionManager)
  protected readonly serialConnection: SerialConnectionManager;

  @inject(BoardsServiceProvider)
  protected readonly boardsServiceProvider: BoardsServiceProvider;

  onStart(app: FrontendApplication): MaybePromise<void> {
    this.url = new Endpoint({ path: '/plotter' }).getRestUrl().toString();

    ipcRenderer.on('CLOSE_CHILD_WINDOW', async () => {
      if (!!this.window) {
        this.window = null;
        await this.serialConnection.closeSerial(Serial.Type.Plotter);
      }
    });

    return super.onStart(app);
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(SerialPlotterContribution.Commands.OPEN, {
      execute: this.connect.bind(this),
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(ArduinoMenus.TOOLS__MAIN_GROUP, {
      commandId: SerialPlotterContribution.Commands.OPEN.id,
      label: SerialPlotterContribution.Commands.OPEN.label,
      order: '7',
    });
  }

  async connect(): Promise<void> {
    if (!!this.window) {
      this.window.focus();
      return;
    }
    const status = await this.serialConnection.openSerial(Serial.Type.Plotter);
    const wsPort = this.serialConnection.getWsPort();
    if (Status.isOK(status) && wsPort) {
      this.open(wsPort);
    } else {
      this.serialConnection.closeSerial(Serial.Type.Plotter);
      this.messageService.error(`Couldn't open serial plotter`);
    }
  }

  protected async open(wsPort: number): Promise<void> {
    const initConfig: Partial<SerialPlotter.Config> = {
      baudrates: SerialConfig.BaudRates.map((b) => b),
      currentBaudrate: this.model.baudRate,
      currentLineEnding: this.model.lineEnding,
      darkTheme: this.themeService.getCurrentTheme().type === 'dark',
      wsPort,
      interpolate: this.model.interpolate,
      connected: await this.serialConnection.isBESerialConnected(),
      serialPort: this.boardsServiceProvider.boardsConfig.selectedPort?.address,
    };
    const urlWithParams = queryString.stringifyUrl(
      {
        url: this.url,
        query: initConfig,
      },
      { arrayFormat: 'comma' }
    );
    this.window = window.open(urlWithParams, 'serialPlotter');
  }
}
