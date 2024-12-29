'use client';

import { useState, type ChangeEvent } from 'react';
import { Button, Text, Card } from '@radix-ui/themes';
import JSZip from 'jszip';
import { processLinkedInUpload } from '@/utils/linkedin/database';
import { createClient } from '@/utils/supabase/client';

const REQUIRED_FILES = ['Profile.csv', 'Connections.csv'];
const OPTIONAL_FILES = ['Positions.csv', 'Education.csv', 'Skills.csv'];

export default function LinkedInUpload() {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  
  const supabase = createClient();

  const validateFiles = (files: File[]): boolean => {
    const fileNames = files.map(f => f.name);
    const hasRequiredFiles = REQUIRED_FILES.every(required => 
      fileNames.some(name => name === required)
    );
    
    if (!hasRequiredFiles) {
      setErrorMessage(`Missing required files. Please ensure you have uploaded ${REQUIRED_FILES.join(' and ')}`);
      return false;
    }
    
    return true;
  };

  const processZipFile = async (file: File): Promise<File[]> => {
    const zip = new JSZip();
    const contents = await zip.loadAsync(file);
    const csvFiles: File[] = [];
    
    for (const [path, zipEntry] of Object.entries(contents.files)) {
      if (!zipEntry.dir) {
        const fileName = path.split('/').pop();
        if (fileName && (REQUIRED_FILES.includes(fileName) || OPTIONAL_FILES.includes(fileName))) {
          const content = await zipEntry.async('blob');
          csvFiles.push(new File([content], fileName, { type: 'text/csv' }));
        }
      }
    }
    
    return csvFiles;
  };

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    setSelectedFiles([]);
    setErrorMessage('');
    
    const fileList: File[] = [];
    
    for (const file of Array.from(files)) {
      if (file.name.endsWith('.zip')) {
        const extractedFiles = await processZipFile(file);
        fileList.push(...extractedFiles);
      } else if (file.name.endsWith('.csv')) {
        fileList.push(file);
      }
    }
    
    if (validateFiles(fileList)) {
      setSelectedFiles(fileList);
    }
  };

  const uploadFiles = async () => {
    try {
      setUploadStatus('uploading');
      
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        throw new Error('Sign-in state could not be verified. Please refresh and try again.');
      }

      const uploadedFiles = [];
      for (const file of selectedFiles) {
        // Upload file to linkedin bucket with user_id prefix
        const filePath = `${user.id}/${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from('linkedin')
          .upload(filePath, file, {
            contentType: 'text/csv',
            upsert: true
          });
          
        if (uploadError) throw uploadError;

        // Get text content for processing
        const textContent = await file.text();
        uploadedFiles.push({ name: file.name, content: textContent });
      }
      
      // Temporarily comment out processing for testing
      // await processLinkedInUpload(user.id, uploadedFiles);
      
      setUploadStatus('success');
      setSelectedFiles([]);
    } catch (error) {
      console.error('Upload error:', error);
      setUploadStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to upload files. Please try again.');
    }
  };

  return (
    <Card style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
      <Text size="2" mb="4">
        Please upload your LinkedIn data export files. Required files: Profile.csv and Connections.csv
      </Text>
      
      <input
        type="file"
        accept=".csv,.zip"
        multiple
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        id="linkedin-data-upload"
      />
      
      <Button
        onClick={() => document.getElementById('linkedin-data-upload')?.click()}
        disabled={uploadStatus === 'uploading'}
      >
        Select Files
      </Button>
      
      {selectedFiles.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <Text size="2" mb="2">Selected files:</Text>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {selectedFiles.map((file, index) => (
              <li key={index}>
                <Text size="2">{file.name}</Text>
              </li>
            ))}
          </ul>
          
          <Button
            onClick={uploadFiles}
            disabled={uploadStatus === 'uploading'}
            style={{ marginTop: '10px' }}
          >
            {uploadStatus === 'uploading' ? 'Uploading...' : 'Upload Files'}
          </Button>
        </div>
      )}
      
      {errorMessage && (
        <Text size="2" color="red" style={{ marginTop: '10px' }}>
          {errorMessage}
        </Text>
      )}
      
      {uploadStatus === 'success' && (
        <Text size="2" color="green" style={{ marginTop: '10px' }}>
          Files uploaded successfully!
        </Text>
      )}
    </Card>
  );
}
