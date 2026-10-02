import { redirect } from 'next/navigation';
import { isValidUuid } from '@/lib/common-utils';
import { MobileUploader } from './mobile-uploader';

export default async function UploadPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  // The upload token lives in the URL fragment, which is intentionally not
  // visible to this server component.
  if (!isValidUuid(sessionId)) {
    redirect('/');
  }

  return <MobileUploader sessionId={sessionId} />;
}
