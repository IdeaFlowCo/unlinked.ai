import Papa from 'papaparse';
import { format } from 'date-fns';
import type { 
  ProcessedLinkedInData, 
  LinkedInProfile, 
  LinkedInConnection,
  LinkedInPosition,
  LinkedInEducation,
  LinkedInSkill 
} from './types';

export function parseLinkedInSlug(url: string): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([^\/\?]+)/);
  return match ? match[1] : null;
}

export function processProfileCsv(content: string): LinkedInProfile | null {
  const { data } = Papa.parse(content, { header: true });
  if (!data.length) return null;

  const row = data[0] as any;
  if (!row['First Name'] || !row['Last Name']) return null;

  return {
    firstName: row['First Name'],
    lastName: row['Last Name'],
    emailAddress: row['Email Address'] || undefined,
    position: row['Headline'] || undefined,
    linkedinSlug: '' // Will be set from auth flow
  };
}

export function processConnectionsCsv(content: string): LinkedInConnection[] {
  // Skip the "Notes:" header lines
  const lines = content.split('\n');
  const headerIndex = lines.findIndex(line => line.startsWith('First Name'));
  if (headerIndex === -1) return [];
  
  const csvContent = lines.slice(headerIndex).join('\n');
  const { data } = Papa.parse(csvContent, { header: true });
  
  return data
    .filter((row: any) => row['First Name'] && row['Last Name'] && row['URL'])
    .map((row: any) => {
      const linkedinSlug = parseLinkedInSlug(row['URL']);
      if (!linkedinSlug) return null;
      
      const connection: LinkedInConnection = {
        firstName: row['First Name'],
        lastName: row['Last Name'],
        linkedinSlug,
        emailAddress: row['Email Address'] || undefined,
        position: row['Position'] || undefined,
        company: row['Company'] || undefined,
        connectedOn: row['Connected On'] || undefined
      };
      return connection;
    })
    .filter((connection): connection is LinkedInConnection => connection !== null);
}

export function processPositionsCsv(content: string): LinkedInPosition[] {
  const { data } = Papa.parse(content, { header: true });
  return data
    .filter((row: any) => {
      const hasTitle = row['Title'] || row['Position'];
      const hasCompany = row['Company'] || row['Company Name'];
      return hasTitle && hasCompany;
    })
    .map((row: any) => ({
      title: row['Title'] || row['Position'],
      company: row['Company'] || row['Company Name'],
      startDate: row['Started On'] || row['Start Date'] || undefined,
      endDate: row['Finished On'] || row['End Date'] || undefined,
      description: row['Description'] || undefined
    }));
}

export function processEducationCsv(content: string): LinkedInEducation[] {
  const { data } = Papa.parse(content, { header: true });
  return data
    .filter((row: any) => row['School'] || row['School Name'])
    .map((row: any) => ({
      school: row['School'] || row['School Name'],
      degree: row['Degree'] || row['Degree Name'] || undefined,
      field: row['Field of Study'] || row['Field'] || undefined,
      startDate: row['Start Date'] || undefined,
      endDate: row['End Date'] || undefined
    }));
}

export function processSkillsCsv(content: string): LinkedInSkill[] {
  const { data } = Papa.parse(content, { header: true });
  return data
    .filter((row: any) => row['Name'] || row['Skill'] || row['Skill Name'])
    .map((row: any) => ({
      name: row['Name'] || row['Skill'] || row['Skill Name']
    }));
}

export async function processLinkedInData(files: { name: string, content: string }[]): Promise<ProcessedLinkedInData | null> {
  const profileFile = files.find(f => f.name === 'Profile.csv');
  const connectionsFile = files.find(f => f.name === 'Connections.csv');
  const positionsFile = files.find(f => f.name === 'Positions.csv');
  const educationFile = files.find(f => f.name === 'Education.csv');
  const skillsFile = files.find(f => f.name === 'Skills.csv');

  if (!profileFile || !connectionsFile) {
    throw new Error('Missing required files: Profile.csv and Connections.csv');
  }

  const profile = processProfileCsv(profileFile.content);
  if (!profile) {
    throw new Error('Failed to process Profile.csv');
  }

  const connections = processConnectionsCsv(connectionsFile.content);
  const positions = positionsFile ? processPositionsCsv(positionsFile.content) : undefined;
  const education = educationFile ? processEducationCsv(educationFile.content) : undefined;
  const skills = skillsFile ? processSkillsCsv(skillsFile.content) : undefined;

  return {
    profile,
    connections,
    positions,
    education,
    skills
  };
}
