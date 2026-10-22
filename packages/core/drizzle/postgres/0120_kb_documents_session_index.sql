CREATE INDEX "kb_documents_tenant_updated_by_session_idx" ON "kb_documents" USING btree ("tenant_id","updated_by_session_id");
