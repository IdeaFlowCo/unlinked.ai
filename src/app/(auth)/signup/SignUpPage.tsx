'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import Papa from 'papaparse';
import * as Form from '@radix-ui/react-form';
import * as Label from '@radix-ui/react-label';
import { UploadCloud, Loader2 } from 'lucide-react';

interface FormData {
  fullName: string;
  email: string;
  password: string;
}

interface LinkedInData {
  raw_data: unknown;
  user_id: string;
  full_name: string;
  created_at: string;
}

const SignUpPage = () => {
  const [formData, setFormData] = useState<FormData>({
    fullName: '',
    email: '',
    password: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;

    if (!uploadedFile.name.endsWith('.csv')) {
      setError('Please upload a CSV file exported from LinkedIn');
      return;
    }

    setFile(uploadedFile);
    setError(null);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (!file) {
        throw new Error('Please upload your LinkedIn data export');
      }

      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: {
          data: {
            full_name: formData.fullName,
          },
        },
      });

      if (authError) throw authError;
      if (!authData?.user) throw new Error('No user data returned');

      const userId = authData.user.id;

      // Read and parse the CSV file
      const fileText = await file.text();
      Papa.parse<unknown>(fileText, {
        header: true,
        complete: async (results) => {
          const profileData: LinkedInData = {
            user_id: userId,
            full_name: formData.fullName,
            raw_data: results.data,
            created_at: new Date().toISOString(),
          };

          const { error: profileError } = await supabase
            .from('profiles')
            .insert(profileData);

          if (profileError) throw profileError;

          // Redirect to dashboard or show success message
          window.location.href = '/dashboard';
        },
        error: (error: Error) => {
          throw new Error(`Error parsing CSV: ${error.message}`);
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-6">
        <div className="space-y-2 mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">Sign Up</h1>
          <p className="text-sm text-gray-500">
            Create an account by uploading your LinkedIn data export
          </p>
        </div>

        <Form.Root onSubmit={handleSubmit} className="space-y-6">
          <Form.Field className="space-y-2" name="fullName">
            <Form.Label className="text-sm font-medium text-gray-700">
              Full Name
            </Form.Label>
            <Form.Control asChild>
              <input
                type="text"
                name="fullName"
                value={formData.fullName}
                onChange={handleInputChange}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter your full name"
              />
            </Form.Control>
            <Form.Message match="valueMissing" className="text-sm text-red-500">
              Please enter your full name
            </Form.Message>
          </Form.Field>

          <Form.Field className="space-y-2" name="email">
            <Form.Label className="text-sm font-medium text-gray-700">
              Email
            </Form.Label>
            <Form.Control asChild>
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleInputChange}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter your email"
              />
            </Form.Control>
            <Form.Message match="valueMissing" className="text-sm text-red-500">
              Please enter your email
            </Form.Message>
            <Form.Message match="typeMismatch" className="text-sm text-red-500">
              Please enter a valid email
            </Form.Message>
          </Form.Field>

          <Form.Field className="space-y-2" name="password">
            <Form.Label className="text-sm font-medium text-gray-700">
              Password
            </Form.Label>
            <Form.Control asChild>
              <input
                type="password"
                name="password"
                value={formData.password}
                onChange={handleInputChange}
                required
                minLength={8}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Create a password"
              />
            </Form.Control>
            <Form.Message match="valueMissing" className="text-sm text-red-500">
              Please enter a password
            </Form.Message>
            <Form.Message match="tooShort" className="text-sm text-red-500">
              Password must be at least 8 characters
            </Form.Message>
          </Form.Field>

          <div className="space-y-2">
            <Label.Root className="text-sm font-medium text-gray-700">
              LinkedIn Data Export
            </Label.Root>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
              <input
                id="file"
                type="file"
                onChange={handleFileChange}
                accept=".csv"
                className="hidden"
              />
              <label
                htmlFor="file"
                className="cursor-pointer flex flex-col items-center space-y-2"
              >
                <UploadCloud className="h-8 w-8 text-gray-400" />
                <span className="text-sm text-gray-600">
                  {file ? file.name : 'Click to upload CSV'}
                </span>
              </label>
            </div>
          </div>

          {error && (
            <div role="alert" className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-md">
              <p className="text-sm">{error}</p>
            </div>
          )}

          <Form.Submit asChild>
            <button
              type="submit"
              className={`w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                loading ? 'opacity-75 cursor-not-allowed' : ''
              }`}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating account...
                </>
              ) : (
                'Create Account'
              )}
            </button>
          </Form.Submit>
        </Form.Root>

        <div className="mt-6 text-center">
          <p className="text-sm text-gray-500">
            Already have an account?{' '}
            <a href="/login" className="text-blue-600 hover:underline">
              Log in
            </a>
          </p>
        </div>
      </div>
    </div>
  );
};

export default SignUpPage;