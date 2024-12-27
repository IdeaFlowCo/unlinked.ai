import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { Readable } from 'stream';
import csv from 'csv-parser';

// Helper function to extract LinkedIn URL slug
function getSlugFromLinkedInUrl(url: string): string {
    if (!url) return '';
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        // Remove /in/ prefix and any trailing slash
        return path.replace(/^\/in\//, '').replace(/\/$/, '');
    } catch (error) {
        console.error('Invalid LinkedIn URL:', url, 'Error:', error instanceof Error ? error.message : String(error));
        return '';
    }
}
import AdmZip from 'adm-zip';

interface ProfileData {
    'First Name': string;
    'Last Name': string;
    'Maiden Name'?: string;
    'Email Address'?: string;
    'Headline': string;
    'Summary': string;
    'Industry': string;
    'Geo Location': string;
    'Address'?: string;
    'Birth Date'?: string;
    'Zip Code'?: string;
    'Twitter Handles'?: string;
    'Websites'?: string;
    'Instant Messengers'?: string;
    'Profile URL': string;
}

interface ConnectionData {
    'First Name': string;
    'Last Name': string;
    'Profile URL': string;
    'Connected On': string;
    'Company'?: string;
    'Position'?: string;
    // Note: Email is intentionally excluded as it belongs in profiles
}

interface PositionData {
    'Company Name': string;
    'Title': string;
    'Description': string;
    'Location': string;
    'Started On': string;
    'Finished On': string;
}

interface EducationData {
    'School Name': string;
    'Degree Name': string;
    'Start Date': string;
    'End Date': string;
    'Activities': string;
    'Notes': string;
}

interface SkillData {
    'Name'?: string;
    'Skill Name'?: string;
}

// Helper function to parse CSV data from a readable stream
async function parseCSV<T>(readable: Readable): Promise<T[]> {
    const results: T[] = [];
    return new Promise((resolve, reject) => {
        readable
            .pipe(csv())
            .on('data', (data: T) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
}

// Removed unused getUserProfile function

// Helper function to process Profile.csv
async function processProfileData(profileData: ProfileData, userId: string) {
    const { data, error } = await supabase
        .from('profiles')
        .upsert({
            user_id: userId,
            first_name: profileData['First Name'],
            last_name: profileData['Last Name'],
            maiden_name: profileData['Maiden Name'],
            email_address: profileData['Email Address'],
            headline: profileData['Headline'],
            summary: profileData['Summary'],
            industry: profileData['Industry'],
            location: profileData['Geo Location'],
            address: profileData['Address'],
            birth_date: profileData['Birth Date'],
            zip_code: profileData['Zip Code'],
            geo_location: profileData['Geo Location'],
            twitter_handles: profileData['Twitter Handles'],
            websites: profileData['Websites'],
            instant_messengers: profileData['Instant Messengers'],
            linkedin_url_slug: getSlugFromLinkedInUrl(profileData['Profile URL'])
        }, {
            onConflict: 'user_id'
        })
        .select()
        .single();

    if (error) {
        throw new Error('Failed to update profile');
    }

    return data;
}

// Helper function to process Positions.csv
async function processPositions(positions: PositionData[], profileId: string) {
    const formattedPositions = positions.map(position => ({
        profile_id: profileId,
        company_name: position['Company Name'],
        title: position['Title'],
        description: position['Description'],
        location: position['Location'],
        started_on: position['Started On'],
        finished_on: position['Finished On']
    }));

    const { error } = await supabase
        .from('positions')
        .upsert(formattedPositions, {
            onConflict: 'profile_id,company_name,title'
        });

    if (error) {
        throw new Error('Failed to update positions');
    }
}

// Helper function to process Education.csv
async function processEducation(education: EducationData[], profileId: string) {
    const formattedEducation = education.map(edu => ({
        profile_id: profileId,
        school_name: edu['School Name'],
        degree_name: edu['Degree Name'],
        start_date: edu['Start Date'],
        end_date: edu['End Date'],
        activities: edu['Activities'],
        notes: edu['Notes']
    }));

    const { error } = await supabase
        .from('education')
        .upsert(formattedEducation, {
            onConflict: 'profile_id,school_name,degree_name'
        });

    if (error) {
        throw new Error('Failed to update education');
    }
}

// Helper function to process Connections.csv
async function processConnections(connections: ConnectionData[], userProfileId: string) {
    for (const connection of connections) {
        // Create or get shadow profile for the connection
        const { data: shadowProfile, error: shadowError } = await supabase
            .from('profiles')
            .upsert({
                first_name: connection['First Name'],
                last_name: connection['Last Name'],
                linkedin_url_slug: getSlugFromLinkedInUrl(connection['Profile URL']),
                current_company: connection['Company'],
                current_position: connection['Position']
            }, {
                onConflict: 'linkedin_url_slug'
            })
            .select()
            .single();

        if (shadowError) {
            console.error('Error creating shadow profile:', shadowError);
            continue;
        }

        // Create connection relationship
        const { error: connectionError } = await supabase
            .from('connections')
            .upsert({
                user_profile_id: userProfileId,
                connection_profile_id: shadowProfile.id,
                connected_on: connection['Connected On']
            }, {
                onConflict: 'user_profile_id,connection_profile_id'
            });

        if (connectionError) {
            console.error('Error creating connection:', connectionError);
        }
    }
}

// Helper function to process Skills.csv
async function processSkills(skills: SkillData[], profileId: string) {
    const formattedSkills = skills.map(skill => ({
        profile_id: profileId,
        name: skill['Name'] || skill['Skill Name'] // Handle different possible column names
    }));

    const { error } = await supabase
        .from('skills')
        .upsert(formattedSkills, {
            onConflict: 'profile_id,name'
        });

    if (error) {
        throw new Error('Failed to update skills');
    }
}

export async function POST(request: NextRequest) {
    try {
        // Get user ID from session
        const { data: { session }, error: authError } = await supabase.auth.getSession();
        if (authError || !session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const userId = session.user.id;

        // Get form data with file
        const formData = await request.formData();
        const file = formData.get('file') as File;
        
        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        // Convert File to Buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        try {
            // Extract ZIP contents
            const zip = new AdmZip(buffer);
            const entries = zip.getEntries();
            if (!entries || entries.length === 0) {
                return NextResponse.json({ error: 'Invalid ZIP file format' }, { status: 400 });
            }
        
            // Process each required CSV file
            let profileData: ProfileData[] = [];
            let positionsData: PositionData[] = [];
            let educationData: EducationData[] = [];
            let skillsData: SkillData[] = [];
            let connectionsData: ConnectionData[] = [];

            // Track which files we've found
            const requiredFiles = new Set(['Profile.csv', 'Connections.csv']);
            const foundFiles = new Set<string>();

            for (const entry of entries) {
                if (entry.entryName.endsWith('.csv')) {
                    let content: Buffer;
                    try {
                        content = entry.getData();
                    } catch (error) {
                        console.error(`Error reading ${entry.entryName}:`, error);
                        continue;
                    }

                    const stream = Readable.from(content);
                    foundFiles.add(entry.entryName);

                    try {
                        switch (entry.entryName) {
                            case 'Profile.csv':
                                profileData = await parseCSV<ProfileData>(stream);
                                break;
                            case 'Positions.csv':
                                positionsData = await parseCSV<PositionData>(stream);
                                break;
                            case 'Education.csv':
                                educationData = await parseCSV<EducationData>(stream);
                                break;
                            case 'Skills.csv':
                                skillsData = await parseCSV<SkillData>(stream);
                                break;
                            case 'Connections.csv':
                                connectionsData = await parseCSV<ConnectionData>(stream);
                                break;
                        }
                    } catch (error) {
                        console.error(`Error parsing ${entry.entryName}:`, error);
                        // Remove from foundFiles if parsing failed
                        foundFiles.delete(entry.entryName);
                    }
                }
            }

            // Check if all required files were found
            const missingFiles = Array.from(requiredFiles).filter(file => !foundFiles.has(file));
            if (missingFiles.length > 0) {
                return NextResponse.json({ 
                    error: `Missing required files: ${missingFiles.join(', ')}`,
                    foundFiles: Array.from(foundFiles)
                }, { status: 400 });
            }

            if (profileData.length === 0) {
                return NextResponse.json({ error: 'Profile data is empty' }, { status: 400 });
            }

            // Process the data in order (profile first, then related data)
            const profile = await processProfileData(profileData[0], userId);

            try {
                // Process related data in parallel
                await Promise.all([
                    positionsData.length > 0 && processPositions(positionsData, profile.id),
                    educationData.length > 0 && processEducation(educationData, profile.id),
                    skillsData.length > 0 && processSkills(skillsData, profile.id),
                    connectionsData.length > 0 && processConnections(connectionsData, profile.id)
                ].filter(Boolean));

                return NextResponse.json({ 
                    message: 'LinkedIn data processed successfully',
                    profile: profile
                });
            } catch (error) {
                console.error('Error processing related data:', error);
                throw new Error(`Failed to process related data: ${error instanceof Error ? error.message : String(error)}`);
            }
        } catch (error) {
            console.error('Error processing ZIP file:', error);
            return NextResponse.json({ error: 'Failed to process ZIP file' }, { status: 500 });
        }

    } catch (error) {
        console.error('Error processing LinkedIn data:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Failed to process LinkedIn data',
            details: error instanceof Error ? {
                name: error.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            } : undefined
        }, { status: 500 });
    }
}
