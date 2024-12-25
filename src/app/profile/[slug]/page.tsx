'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Flex, Box, Text, Heading } from '@radix-ui/themes';
import { useParams } from 'next/navigation';

interface Profile {
    id: string;
    first_name: string;
    last_name: string;
    headline: string;
    summary: string;
    industry: string;
    location: string;
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

export default function ProfilePage() {
    const params = useParams();
    const [profile, setProfile] = useState<Profile | null>(null);
    const [positions, setPositions] = useState<Position[]>([]);
    const [education, setEducation] = useState<Education[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchProfileData() {
            if (!params.slug) return;

            try {
                // Fetch profile data
                const { data: profileData, error: profileError } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('id', params.slug)
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

            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load profile data');
            } finally {
                setLoading(false);
            }
        }

        fetchProfileData();
    }, [params.slug]);

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
                <Text>Profile not found.</Text>
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
        </Box>
    );
}
