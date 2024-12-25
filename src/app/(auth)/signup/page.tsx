import { Metadata } from 'next';
import SignUpPage from './SignUpPage';

export const metadata: Metadata = {
  title: 'Sign Up - LinkedIn Network',
  description: 'Create an account by uploading your LinkedIn data export',
};

export default function SignUpRoute() {
  return <SignUpPage />;
}