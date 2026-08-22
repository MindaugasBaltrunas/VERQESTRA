import { useRef, useState } from "react";

/**
 * `alert()` buvo klaidų kanalas iki 2026-08-06 UI audito: jis blokuoja naršyklės giją, nėra
 * stilizuotas, neverčiamas ir jsdom testuose meta „not implemented" — t. y. netestuojamas.
 * Klaida dabar yra komponento būsena, kurią kviečiantis komponentas atvaizduoja įprastai.
 */
export function useQueueUploadController(onUpload: (files: File[]) => Promise<void>) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  async function handleFiles(files: FileList | File[]) {
    const markdownFiles = Array.from(files).filter((file) =>
      file.name.toLowerCase().endsWith(".md"),
    );

    if (markdownFiles.length === 0) {
      setUploadError("Select .md files.");
      return;
    }

    setIsUploading(true);
    setUploadError("");
    try {
      await onUpload(markdownFiles);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsUploading(false);
    }
  }

  return {
    fileInputRef,
    isDragOver,
    isUploading,
    uploadError,
    clearUploadError: () => setUploadError(""),
    openFilePicker: () => fileInputRef.current?.click(),
    dragOver: () => setIsDragOver(true),
    dragLeave: () => setIsDragOver(false),
    dropFiles: (files: FileList) => {
      setIsDragOver(false);
      void handleFiles(files);
    },
    selectFiles: () => {
      const input = fileInputRef.current;
      if (!input?.files) return;
      const files = Array.from(input.files);
      // Įvesties reikšmė išvaloma, kad TAS PATS failas galėtų būti pasirinktas dar kartą.
      // Be to nepavykus įkėlimui (serveris 500) pakartotinis to paties failo pasirinkimas
      // `change` įvykio nebegeneruodavo — nieko nevykdavo ir jokio pranešimo nebūdavo
      // (2026-08-06 UI auditas).
      input.value = "";
      void handleFiles(files);
    },
  };
}
