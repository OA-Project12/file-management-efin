import "server-only";
import type {
  FileDeletionRequestResult,
  FileRepository,
  FileScope,
} from "@/application/files/ports/file-repository";

export class RequestFileDeletion {
  constructor(private readonly fileRepository: FileRepository) {}

  execute(fileId: string, scope: FileScope): Promise<FileDeletionRequestResult> {
    return this.fileRepository.requestDelete(fileId, scope);
  }
}
