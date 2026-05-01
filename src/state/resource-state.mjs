export function mergeResourceManifest(manifest, resourceMap) {
  const now = new Date().toISOString();
  for (const resource of resourceMap.imageResources) {
    if (!resource.outputRelativePath || resource.missing) continue;
    manifest.resources[resource.resourceId] = {
      resource_id: resource.resourceId,
      type: 'image',
      output_relative_path: resource.outputRelativePath,
      occurrence_count: resource.occurrenceCount,
      last_seen_at: now
    };
  }

  for (const attachment of resourceMap.nonImageAttachments) {
    if (!attachment.outputRelativePath || !attachment.matched) continue;
    const id = attachment.id || attachment.placeholderId;
    manifest.resources[id] = {
      resource_id: id,
      type: 'attachment',
      output_relative_path: attachment.outputRelativePath,
      occurrence_count: 1,
      last_seen_at: now
    };
  }
}
