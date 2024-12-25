'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Flex, Box, Text, Heading, ScrollArea } from '@radix-ui/themes';
import { MagnifyingGlassIcon } from '@radix-ui/react-icons';
import type { ChangeEvent } from 'react';

interface Profile {
    id: string;
    first_name: string;
    last_name: string;
    headline: string;
    summary: string;
    industry: string;
    location: string;
}

interface ConnectionResponse {
    connection_profile: Profile;
    connected_on: string;
}

interface Position {
    company_name: string;
    title: string;
    description: string;
    location: string;
    started_on: string;
    finished_on: string | null;
}

interface Education {
    school_name: string;
    degree_name: string;
    start_date: string;
    end_date: string;
    activities: string;
    notes: string;
}

interface Connection {
    profile: Profile;
    connected_on: string;
}

export default function ProfilePage() {
    const [profile, setProfile] = useState<Profile | null>(null);
    const [positions, setPositions] = useState<Position[]>([]);
    const [education, setEducation] = useState<Education[]>([]);
    const [connections, setConnections] = useState<Connection[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchProfileData() {
            try {
                const { data: { session }, error: authError } = await supabase.auth.getSession();
                if (authError || !session?.user?.id) {
                    throw new Error('Not authenticated');
                }

                // Fetch profile data
                const { data: profileData, error: profileError } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('user_id', session.user.id)
                    .single();

                if (profileError) throw profileError;
                if (!profileData) throw new Error('Profile not found');

                setProfile(profileData);

                // Fetch positions
                const { data: positionsData, error: positionsError } = await supabase
                    .from('positions')
                    .select('*')
                    .eq('profile_id', profileData.id)
                    .order('started_on', { ascending: false });

                if (positionsError) throw positionsError;
                setPositions(positionsData || []);

                // Fetch education
                const { data: educationData, error: educationError } = await supabase
                    .from('education')
                    .select('*')
                    .eq('profile_id', profileData.id)
                    .order('start_date', { ascending: false });

                if (educationError) throw educationError;
                setEducation(educationData || []);

                // Fetch connections with their profiles
                const { data: connectionsData, error: connectionsError } = await supabase
                    .from('connections')
                    .select(`
                        connected_on,
                        connection_profile:profiles!connections_connection_profile_id_fkey (
                            id,
                            first_name,
                            last_name,
                            headline,
                            summary,
                            industry,
                            location
                        )
                    `)
                    .eq('user_profile_id', profileData.id);

                if (connectionsError) throw connectionsError;
                const formattedConnections = (connectionsData as unknown as ConnectionResponse[] | null)?.map(c => ({
                    profile: c.connection_profile,
                    connected_on: c.connected_on
                })) || [];
                setConnections(formattedConnections);

            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load profile data');
            } finally {
                setLoading(false);
            }
        }

        fetchProfileData();
    }, []);

    const filteredConnections = connections.filter(connection => {
        const searchLower = searchQuery.toLowerCase();
        const fullName = `${connection.profile.first_name} ${connection.profile.last_name}`.toLowerCase();
        return fullName.includes(searchLower) ||
               (connection.profile.headline?.toLowerCase().includes(searchLower)) ||
               (connection.profile.location?.toLowerCase().includes(searchLower));
    });

    if (loading) {
        return (
            <Box p="6">
                <Text>Loading profile...</Text>
            </Box>
        );
    }

    if (error) {
        return (
            <Box p="6">
                <Text color="red">{error}</Text>
            </Box>
        );
    }

    if (!profile) {
        return (
            <Box p="6">
                <Text>Profile not found. Please complete the onboarding process.</Text>
            </Box>
        );
    }

    return (
        <Box className="max-w-4xl mx-auto" p="6">
            {/* Profile Header */}
            <Flex direction="column" gap="4" mb="6">
                <Heading size="8">{profile.first_name} {profile.last_name}</Heading>
                <Text size="5" color="gray">{profile.headline}</Text>
                <Text>{profile.location}</Text>
                {profile.summary && (
                    <Text>{profile.summary}</Text>
                )}
            </Flex>

            {/* Work Experience */}
            <Box mb="8">
                <Heading size="6" mb="4">Work Experience</Heading>
                <Flex direction="column" gap="4">
                    {positions.map((position, index) => (
                        <Box key={index}>
                            <Text weight="bold">{position.title}</Text>
                            <Text color="gray">{position.company_name}</Text>
                            <Text size="2">
                                {position.started_on} - {position.finished_on || 'Present'}
                            </Text>
                            {position.description && (
                                <Text size="2" mt="2">{position.description}</Text>
                            )}
                        </Box>
                    ))}
                </Flex>
            </Box>

            {/* Education */}
            <Box mb="8">
                <Heading size="6" mb="4">Education</Heading>
                <Flex direction="column" gap="4">
                    {education.map((edu, index) => (
                        <Box key={index}>
                            <Text weight="bold">{edu.school_name}</Text>
                            <Text>{edu.degree_name}</Text>
                            <Text size="2">
                                {edu.start_date} - {edu.end_date}
                            </Text>
                            {edu.activities && (
                                <Text size="2" mt="2">{edu.activities}</Text>
                            )}
                        </Box>
                    ))}
                </Flex>
            </Box>

            {/* Connections */}
            <Box>
                <Flex justify="between" align="center" mb="4">
                    <Heading size="6">Connections</Heading>
                    <Box style={{ width: '300px' }}>
                        <Box className="relative">
                            <MagnifyingGlassIcon className="absolute left-2 top-1/2 transform -translate-y-1/2" height="16" width="16" />
                            <input
                                type="text"
                                className="w-full pl-8 pr-4 py-2 rounded-md border border-gray-300"
                                placeholder="Search connections..."
                                value={searchQuery}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                            />
                        </Box>
                    </Box>
                </Flex>
                <ScrollArea style={{ height: '400px' }}>
                    <Flex direction="column" gap="3">
                        {filteredConnections.map((connection, index) => (
                            <Box
                                key={index}
                                p="3"
                                style={{
                                    border: '1px solid var(--gray-a5)',
                                    borderRadius: 'var(--radius-3)',
                                }}
                            >
                                <Text weight="bold">
                                    <a href={`/profile/${connection.profile.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                                        {connection.profile.first_name} {connection.profile.last_name}
                                    </a>
                                </Text>
                                {connection.profile.headline && (
                                    <Text size="2" color="gray">{connection.profile.headline}</Text>
                                )}
                                {connection.profile.location && (
                                    <Text size="2">{connection.profile.location}</Text>
                                )}
                            </Box>
                        ))}
                    </Flex>
                </ScrollArea>
            </Box>
        </Box>
    );
}
