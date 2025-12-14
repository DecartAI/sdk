import { useEffect, useState } from "react";

export function useObjectURL(file: File | undefined) {
  const [url, setUrl] = useState<string | undefined>();

  useEffect(() => {
    if (!file) {
      setUrl(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return url;
}
