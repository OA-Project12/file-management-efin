import "server-only";
import type { FilePagePosition, FileRepository, FileScope, FileSearchFilters } from "@/application/files/ports/file-repository";

export class ListFiles {
  constructor(private readonly fileRepository: FileRepository) {}

  execute(scope: FileScope, limit: number, before?: FilePagePosition, filters?: FileSearchFilters) {
    return this.fileRepository.listAvailable(scope, limit, before, filters);
  }
}
