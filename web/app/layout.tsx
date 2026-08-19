import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MBTA Prediction Reliability',
  description:
    'How wrong are MBTA arrival predictions? Measured from recorded predictions and observed arrivals.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
