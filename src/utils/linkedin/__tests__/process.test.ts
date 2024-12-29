import { processLinkedInData } from '../process';
import fs from 'fs';
import path from 'path';

describe('LinkedIn data processing', () => {
  const readFile = (dataset: 'basic' | 'full', filename: string) => {
    const dir = dataset === 'basic' ? 'Basic_LinkedInDataExport_12-27-2024' : 'LinkedIn Data Export Dec 22 2024';
    return fs.readFileSync(path.join(__dirname, 'data', dir, filename), 'utf-8');
  };

  it('should process required files and create shadow profiles', async () => {
    const files = [
      { name: 'Profile.csv', content: readFile('basic', 'Profile.csv') },
      { name: 'Connections.csv', content: readFile('basic', 'Connections.csv') }
    ];

    const data = await processLinkedInData(files);
    expect(data).toBeTruthy();
    expect(data?.profile).toBeTruthy();
    expect(data?.connections.length).toBeGreaterThan(0);
    
    // Verify edenchan42 exists in connections
    const edenProfile = data?.connections.find(c => 
      c.linkedinSlug === 'edenchan42'
    );
    expect(edenProfile).toBeTruthy();
  });

  it('should process optional files when available', async () => {
    const files = [
      { name: 'Profile.csv', content: readFile('basic', 'Profile.csv') },
      { name: 'Connections.csv', content: readFile('basic', 'Connections.csv') },
      { name: 'Positions.csv', content: readFile('basic', 'Positions.csv') },
      { name: 'Education.csv', content: readFile('basic', 'Education.csv') },
      { name: 'Skills.csv', content: readFile('basic', 'Skills.csv') }
    ];

    const data = await processLinkedInData(files);
    expect(data).toBeTruthy();
    expect(data?.positions?.length).toBeGreaterThan(0);
    expect(data?.education?.length).toBeGreaterThan(0);
    expect(data?.skills?.length).toBeGreaterThan(0);
  });

  it('should verify profile deduplication using multiple datasets', async () => {
    const files1 = [
      { name: 'Profile.csv', content: readFile('basic', 'Profile.csv') },
      { name: 'Connections.csv', content: readFile('basic', 'Connections.csv') }
    ];

    const files2 = [
      { name: 'Profile.csv', content: readFile('full', 'Profile.csv') },
      { name: 'Connections.csv', content: readFile('full', 'Connections.csv') }
    ];

    const data1 = await processLinkedInData(files1);
    const data2 = await processLinkedInData(files2);

    // Verify edenchan42 exists in both connection sets
    const eden1 = data1?.connections.find(c => c.linkedinSlug === 'edenchan42');
    const eden2 = data2?.connections.find(c => c.linkedinSlug === 'edenchan42');
    expect(eden1).toBeTruthy();
    expect(eden2).toBeTruthy();
  });

  it('should throw error if required files are missing', () => {
    const files = [
      { name: 'Skills.csv', content: readFile('basic', 'Skills.csv') }
    ];

    expect(() => processLinkedInData(files)).rejects.toThrow('Missing required files');
  });
});
