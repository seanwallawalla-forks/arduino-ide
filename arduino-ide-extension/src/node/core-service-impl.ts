import { FileUri } from '@theia/core/lib/node/file-uri';
import { inject, injectable } from 'inversify';
import { relative } from 'path';
import * as jspb from 'google-protobuf';
import { BoolValue } from 'google-protobuf/google/protobuf/wrappers_pb';
import { ClientReadableStream } from '@grpc/grpc-js';
import { CompilerWarnings, CoreService } from '../common/protocol/core-service';
import {
  CompileRequest,
  CompileResponse,
} from './cli-protocol/cc/arduino/cli/commands/v1/compile_pb';
import { CoreClientAware } from './core-client-provider';
import {
  BurnBootloaderRequest,
  BurnBootloaderResponse,
  UploadRequest,
  UploadResponse,
  UploadUsingProgrammerRequest,
  UploadUsingProgrammerResponse,
} from './cli-protocol/cc/arduino/cli/commands/v1/upload_pb';
import { ResponseService } from '../common/protocol/response-service';
import { NotificationServiceServer } from '../common/protocol';
import { ArduinoCoreServiceClient } from './cli-protocol/cc/arduino/cli/commands/v1/commands_grpc_pb';
import { firstToUpperCase, firstToLowerCase } from '../common/utils';
import { Port } from './cli-protocol/cc/arduino/cli/commands/v1/port_pb';
import { SerialService } from './../common/protocol/serial-service';

@injectable()
export class CoreServiceImpl extends CoreClientAware implements CoreService {
  @inject(ResponseService)
  protected readonly responseService: ResponseService;

  @inject(NotificationServiceServer)
  protected readonly notificationService: NotificationServiceServer;

  @inject(SerialService)
  protected readonly serialService: SerialService;

  protected uploading = false;

  async compile(
    options: CoreService.Compile.Options & {
      exportBinaries?: boolean;
      compilerWarnings?: CompilerWarnings;
    }
  ): Promise<void> {
    const { sketchUri, fqbn, compilerWarnings } = options;
    const sketchPath = FileUri.fsPath(sketchUri);

    await this.coreClientProvider.initialized;
    const coreClient = await this.coreClient();
    const { client, instance } = coreClient;

    const compileReq = new CompileRequest();
    compileReq.setInstance(instance);
    compileReq.setSketchPath(sketchPath);
    if (fqbn) {
      compileReq.setFqbn(fqbn);
    }
    if (compilerWarnings) {
      compileReq.setWarnings(compilerWarnings.toLowerCase());
    }
    compileReq.setOptimizeForDebug(options.optimizeForDebug);
    compileReq.setPreprocess(false);
    compileReq.setVerbose(options.verbose);
    compileReq.setQuiet(false);
    if (typeof options.exportBinaries === 'boolean') {
      const exportBinaries = new BoolValue();
      exportBinaries.setValue(options.exportBinaries);
      compileReq.setExportBinaries(exportBinaries);
    }
    this.mergeSourceOverrides(compileReq, options);

    const result = client.compile(compileReq);
    try {
      await new Promise<void>((resolve, reject) => {
        result.on('data', (cr: CompileResponse) => {
          this.responseService.appendToOutput({
            chunk: Buffer.from(cr.getOutStream_asU8()).toString(),
          });
          this.responseService.appendToOutput({
            chunk: Buffer.from(cr.getErrStream_asU8()).toString(),
          });
        });
        result.on('error', (error) => reject(error));
        result.on('end', () => resolve());
      });
      this.responseService.appendToOutput({
        chunk: '\n--------------------------\nCompilation complete.\n',
      });
    } catch (e) {
      this.responseService.appendToOutput({
        chunk: `Compilation error: ${e.details}\n`,
        severity: 'error',
      });
      throw e;
    }
  }

  async upload(options: CoreService.Upload.Options): Promise<void> {
    await this.doUpload(
      options,
      () => new UploadRequest(),
      (client, req) => client.upload(req)
    );
  }

  async uploadUsingProgrammer(
    options: CoreService.Upload.Options
  ): Promise<void> {
    await this.doUpload(
      options,
      () => new UploadUsingProgrammerRequest(),
      (client, req) => client.uploadUsingProgrammer(req),
      'upload using programmer'
    );
  }

  isUploading(): Promise<boolean> {
    return Promise.resolve(this.uploading);
  }

  protected async doUpload(
    options: CoreService.Upload.Options,
    requestProvider: () => UploadRequest | UploadUsingProgrammerRequest,
    // tslint:disable-next-line:max-line-length
    responseHandler: (
      client: ArduinoCoreServiceClient,
      req: UploadRequest | UploadUsingProgrammerRequest
    ) => ClientReadableStream<UploadResponse | UploadUsingProgrammerResponse>,
    task = 'upload'
  ): Promise<void> {
    await this.compile(Object.assign(options, { exportBinaries: false }));

    this.uploading = true;
    this.serialService.uploadInProgress = true;

    await this.serialService.disconnect();

    const { sketchUri, fqbn, port, programmer } = options;
    const sketchPath = FileUri.fsPath(sketchUri);

    await this.coreClientProvider.initialized;
    const coreClient = await this.coreClient();
    const { client, instance } = coreClient;

    const req = requestProvider();
    req.setInstance(instance);
    req.setSketchPath(sketchPath);
    if (fqbn) {
      req.setFqbn(fqbn);
    }
    const p = new Port();
    if (port) {
      p.setAddress(port.address);
      p.setLabel(port.label || '');
      p.setProtocol(port.protocol);
    }
    req.setPort(p);
    if (programmer) {
      req.setProgrammer(programmer.id);
    }
    req.setVerbose(options.verbose);
    req.setVerify(options.verify);

    options.userFields.forEach((e) => {
      req.getUserFieldsMap().set(e.name, e.value);
    });

    const result = responseHandler(client, req);

    try {
      await new Promise<void>((resolve, reject) => {
        result.on('data', (resp: UploadResponse) => {
          this.responseService.appendToOutput({
            chunk: Buffer.from(resp.getOutStream_asU8()).toString(),
          });
          this.responseService.appendToOutput({
            chunk: Buffer.from(resp.getErrStream_asU8()).toString(),
          });
        });
        result.on('error', (error) => reject(error));
        result.on('end', () => resolve());
      });
      this.responseService.appendToOutput({
        chunk:
          '\n--------------------------\n' +
          firstToLowerCase(task) +
          ' complete.\n',
      });
    } catch (e) {
      this.responseService.appendToOutput({
        chunk: `${firstToUpperCase(task)} error: ${e.details}\n`,
        severity: 'error',
      });
      throw e;
    } finally {
      this.uploading = false;
      this.serialService.uploadInProgress = false;
    }
  }

  async burnBootloader(options: CoreService.Bootloader.Options): Promise<void> {
    this.uploading = true;
    this.serialService.uploadInProgress = true;
    await this.serialService.disconnect();

    await this.coreClientProvider.initialized;
    const coreClient = await this.coreClient();
    const { client, instance } = coreClient;
    const { fqbn, port, programmer } = options;
    const burnReq = new BurnBootloaderRequest();
    burnReq.setInstance(instance);
    if (fqbn) {
      burnReq.setFqbn(fqbn);
    }
    const p = new Port();
    if (port) {
      p.setAddress(port.address);
      p.setLabel(port.label || '');
      p.setProtocol(port.protocol);
    }
    burnReq.setPort(p);
    if (programmer) {
      burnReq.setProgrammer(programmer.id);
    }
    burnReq.setVerify(options.verify);
    burnReq.setVerbose(options.verbose);
    const result = client.burnBootloader(burnReq);
    try {
      await new Promise<void>((resolve, reject) => {
        result.on('data', (resp: BurnBootloaderResponse) => {
          this.responseService.appendToOutput({
            chunk: Buffer.from(resp.getOutStream_asU8()).toString(),
          });
          this.responseService.appendToOutput({
            chunk: Buffer.from(resp.getErrStream_asU8()).toString(),
          });
        });
        result.on('error', (error) => reject(error));
        result.on('end', () => resolve());
      });
    } catch (e) {
      this.responseService.appendToOutput({
        chunk: `Error while burning the bootloader: ${e.details}\n`,
        severity: 'error',
      });
      throw e;
    } finally {
      this.uploading = false;
      this.serialService.uploadInProgress = false;
    }
  }

  private mergeSourceOverrides(
    req: { getSourceOverrideMap(): jspb.Map<string, string> },
    options: CoreService.Compile.Options
  ): void {
    const sketchPath = FileUri.fsPath(options.sketchUri);
    for (const uri of Object.keys(options.sourceOverride)) {
      const content = options.sourceOverride[uri];
      if (content) {
        const relativePath = relative(sketchPath, FileUri.fsPath(uri));
        req.getSourceOverrideMap().set(relativePath, content);
      }
    }
  }
}
