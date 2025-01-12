'use client'

import { useState, useCallback } from 'react'
import { Card, Text, Box, Flex, Button, IconButton, Separator, Badge, Avatar, Heading, Skeleton } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/client'
import type { Database } from '@/utils/supabase/types'
import { Cross2Icon } from '@radix-ui/react-icons'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

// Schema types
type Tables = Database['public']['Tables']
type Profile = Tables['profiles']['Row'] & {
    positions: (Tables['positions']['Row'] & {
        companies: Tables['companies']['Row'] | null
    })[]
    education: (Tables['education']['Row'] & {
        institutions: Tables['institutions']['Row'] | null
    })[]
    skills: Tables['skills']['Row'][]
}

interface EditProfileFormProps {
    profile: Profile
    onCancel: () => void
    onSave: () => void
}

// Validation schema based on database types
const positionSchema = z.object({
    id: z.string().optional(),
    title: z.string().nullable().transform(v => v || ''),
    company_name: z.string().min(1, 'Company name is required'),
    started_on: z.string().nullable().transform(v => v ? v : null),
    finished_on: z.string().nullable().transform(v => v ? v : null),
    description: z.string().nullable().transform(v => v || '')
})

const educationSchema = z.object({
    id: z.string().optional(),
    degree_name: z.string().nullable().transform(v => v || ''),
    institution_name: z.string().min(1, 'Institution name is required'),
    started_on: z.string().nullable().transform(v => v ? v : null),
    finished_on: z.string().nullable().transform(v => v ? v : null)
})

const skillSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1, 'Skill name is required')
})

const formSchema = z.object({
    full_name: z.string().nullable().transform(v => v || ''),
    headline: z.string().nullable().transform(v => v || ''),
    summary: z.string().nullable().transform(v => v || ''),
    industry: z.string().nullable().transform(v => v || ''),
    positions: z.array(positionSchema),
    education: z.array(educationSchema),
    skills: z.array(skillSchema),
    newSkill: z.string().optional()
})

type FormValues = z.infer<typeof formSchema>

// Form component
export default function EditProfileForm({ profile, onCancel, onSave }: EditProfileFormProps) {
    const [isLoading, setIsLoading] = useState(false)
    const supabase = createClient()

    // Initialize form with profile data
    const {
        control,
        handleSubmit,
        formState: { isDirty },
        reset
    } = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            full_name: profile.full_name || '',
            headline: profile.headline || '',
            summary: profile.summary || '',
            industry: profile.industry || '',
            positions: profile.positions.map(p => ({
                id: p.id,
                title: p.title || '',
                company_name: p.companies?.name || '',
                started_on: p.started_on || '',
                finished_on: p.finished_on === null ? '' : p.finished_on,
                description: p.description || ''
            })),
            education: profile.education.map(e => ({
                id: e.id,
                degree_name: e.degree_name || '',
                institution_name: e.institutions?.name || '',
                started_on: e.started_on || '',
                finished_on: e.finished_on === null ? '' : e.finished_on
            })),
            skills: profile.skills.map(s => ({
                id: s.id,
                name: s.name
            })),
            newSkill: ''
        }
    })

    // Field arrays for dynamic fields
    const {
        fields: positionFields,
        append: appendPosition,
        remove: removePosition
    } = useFieldArray({
        control,
        name: 'positions'
    })

    const {
        fields: educationFields,
        append: appendEducation,
        remove: removeEducation
    } = useFieldArray({
        control,
        name: 'education'
    })

    const {
        fields: skillFields,
        append: appendSkill,
        remove: removeSkill
    } = useFieldArray({
        control,
        name: 'skills'
    })

    // Form submission
    const onSubmit = useCallback(async (data: FormValues) => {
        setIsLoading(true)
        try {
            // Prepare all operations
            const operations = []

            // Update profile
            operations.push(
                supabase
                    .from('profiles')
                    .update({
                        full_name: data.full_name,
                        headline: data.headline,
                        summary: data.summary,
                        industry: data.industry
                    })
                    .eq('id', profile.id)
            )

            // Handle positions
            const existingPositionIds = new Set(profile.positions.map(p => p.id))
            const updatedPositionIds = new Set(data.positions.filter(p => p.id).map(p => p.id))
            const positionsToDelete = [...existingPositionIds].filter(id => !updatedPositionIds.has(id))

            // Delete removed positions in one operation
            if (positionsToDelete.length > 0) {
                operations.push(
                    supabase
                        .from('positions')
                        .delete()
                        .in('id', positionsToDelete)
                )
            }

            // Group positions by company to reduce queries
            const positionsByCompany = data.positions.reduce((acc, position) => {
                if (!position.company_name.trim()) return acc
                const companyName = position.company_name.trim()
                if (!acc[companyName]) acc[companyName] = []
                acc[companyName].push(position)
                return acc
            }, {} as Record<string, typeof data.positions>)

            // Handle companies and their positions
            const companyOperations = Object.entries(positionsByCompany).map(async ([companyName, positions]) => {
                // First try to find existing company
                const { data: existingCompany } = await supabase
                    .from('companies')
                    .select()
                    .eq('name', companyName)
                    .single()

                // If company doesn't exist, create it
                const company = existingCompany || await (async () => {
                    const { data, error } = await supabase
                        .from('companies')
                        .insert({ name: companyName })
                        .select()
                        .single()

                    if (error) throw error
                    if (!data) throw new Error('Failed to create company')
                    return data
                })()

                // Prepare position updates and inserts
                const positionOperations = positions.map(position => {
                    const positionData = {
                        company_id: company.id,
                        title: position.title,
                        description: position.description,
                        started_on: position.started_on || null,
                        finished_on: position.finished_on || null
                    }

                    if (position.id) {
                        return supabase
                            .from('positions')
                            .update(positionData)
                            .eq('id', position.id)
                    } else {
                        return supabase
                            .from('positions')
                            .insert({ ...positionData, profile_id: profile.id })
                    }
                })

                return Promise.all(positionOperations)
            })

            operations.push(...companyOperations)

            // Handle education
            const existingEducationIds = new Set(profile.education.map(e => e.id))
            const updatedEducationIds = new Set(data.education.filter(e => e.id).map(e => e.id))
            const educationToDelete = [...existingEducationIds].filter(id => !updatedEducationIds.has(id))

            // Delete removed education entries in one operation
            if (educationToDelete.length > 0) {
                operations.push(
                    supabase
                        .from('education')
                        .delete()
                        .in('id', educationToDelete)
                )
            }

            // Group education by institution to reduce queries
            const educationByInstitution = data.education.reduce((acc, edu) => {
                if (!edu.institution_name.trim()) return acc
                const institutionName = edu.institution_name.trim()
                if (!acc[institutionName]) acc[institutionName] = []
                acc[institutionName].push(edu)
                return acc
            }, {} as Record<string, typeof data.education>)

            // Handle institutions and their education entries
            const educationOperations = Object.entries(educationByInstitution).map(async ([institutionName, educations]) => {
                // First try to find existing institution
                const { data: existingInstitution } = await supabase
                    .from('institutions')
                    .select()
                    .eq('name', institutionName)
                    .single()

                // If institution doesn't exist, create it
                const institution = existingInstitution || await (async () => {
                    const { data, error } = await supabase
                        .from('institutions')
                        .insert({ name: institutionName })
                        .select()
                        .single()

                    if (error) throw error
                    if (!data) throw new Error('Failed to create institution')
                    return data
                })()

                // Prepare education updates and inserts
                const educationOperations = educations.map(edu => {
                    const educationData = {
                        institution_id: institution.id,
                        degree_name: edu.degree_name,
                        started_on: edu.started_on || null,
                        finished_on: edu.finished_on || null
                    }

                    if (edu.id) {
                        return supabase
                            .from('education')
                            .update(educationData)
                            .eq('id', edu.id)
                    } else {
                        return supabase
                            .from('education')
                            .insert({ ...educationData, profile_id: profile.id })
                    }
                })

                return Promise.all(educationOperations)
            })

            operations.push(...educationOperations)

            // Handle skills in one operation
            const existingSkillIds = new Set(profile.skills.map(s => s.id))
            const updatedSkillIds = new Set(data.skills.filter(s => s.id).map(s => s.id))
            const skillsToDelete = [...existingSkillIds].filter(id => !updatedSkillIds.has(id))

            if (skillsToDelete.length > 0) {
                operations.push(
                    supabase
                        .from('skills')
                        .delete()
                        .in('id', skillsToDelete)
                )
            }

            const skillsToUpsert = data.skills
                .filter(s => s.name.trim())
                .map(s => ({
                    id: s.id,
                    name: s.name.trim(),
                    profile_id: profile.id
                }))

            if (skillsToUpsert.length > 0) {
                operations.push(
                    supabase
                        .from('skills')
                        .upsert(skillsToUpsert)
                )
            }

            // Execute all operations in parallel
            await Promise.all(operations)
            onSave()
        } catch (err) {
            console.error('Error updating profile:', err)
            // TODO: Add proper error handling/display
        } finally {
            setIsLoading(false)
        }
    }, [profile, supabase, onSave])

    const handleCancel = () => {
        reset()
        onCancel()
    }

    return (
        <Box>
            <Box style={{
                position: 'fixed',
                top: 'var(--header-height)',
                left: 0,
                right: 0,
                padding: 'var(--space-3)',
                zIndex: 9
            }}>
                <Flex align="center" gap="3" justify="end" style={{
                    maxWidth: '800px',
                    margin: '0 auto',
                    width: '100%',
                    paddingInline: 'var(--space-3)'
                }}>
                    <Button
                        type="button"
                        size={{ initial: '3', sm: '3' }}
                        variant="soft"
                        style={{ width: '50px' }}
                        onClick={handleCancel}
                    >
                        ✕
                    </Button>
                    <Button
                        type="submit"
                        size={{ initial: '3', sm: '3' }}
                        variant="solid"
                        color="violet"
                        style={{ width: '50px' }}
                        disabled={isLoading || !isDirty}
                        form="edit-profile-form"
                    >
                        {isLoading ? <Skeleton>✓</Skeleton> : '✓'}
                    </Button>
                </Flex>
            </Box>
            <Box />
            <form id="edit-profile-form" onSubmit={handleSubmit(onSubmit)} noValidate>
                <Flex direction="column" gap="6" style={{
                    marginTop: 0,
                    maxWidth: '800px',
                    margin: '0 auto',
                    padding: 'var(--space-3)'
                }}>
                    <Card size="4" className="profile-hero-card">
                        <Flex gap="6" p="6">
                            <Avatar
                                size="5"
                                fallback={(profile.full_name?.charAt(0) || 'U').toUpperCase()}
                                style={{
                                    border: '3px solid var(--accent-6)',
                                    backgroundColor: 'var(--accent-2)'
                                }}
                            />
                            <Box style={{ flex: 1 }}>
                                <Flex align="center" gap="3" mb="2" justify="between">
                                    <Flex align="center" gap="3" wrap="wrap">
                                        <Box style={{
                                            maxWidth: '600px',
                                            flex: 1,
                                            minWidth: 0
                                        }}>
                                            <Heading size="6" style={{
                                                background: 'linear-gradient(to right, var(--accent-9), var(--accent-11))',
                                                WebkitBackgroundClip: 'text',
                                                WebkitTextFillColor: 'transparent',
                                                width: '100%'
                                            }}>
                                                <Controller
                                                    name="full_name"
                                                    control={control}
                                                    render={({ field: { value, onChange, ...field } }) => (
                                                        <div
                                                            {...field}
                                                            contentEditable
                                                            suppressContentEditableWarning
                                                            onInput={(e) => {
                                                                onChange(e.currentTarget.textContent);
                                                                // Adjust height
                                                                e.currentTarget.style.height = 'auto';
                                                                e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px';
                                                            }}
                                                            onBlur={(e) => {
                                                                onChange(e.currentTarget.textContent);
                                                            }}
                                                            dangerouslySetInnerHTML={{ __html: value || 'Your Name' }}
                                                            style={{
                                                                width: '100%',
                                                                background: 'none',
                                                                border: 'none',
                                                                outline: 'none',
                                                                padding: 0,
                                                                margin: 0,
                                                                fontSize: 'inherit',
                                                                lineHeight: '1.4',
                                                                fontWeight: 'inherit',
                                                                color: 'inherit',
                                                                WebkitBackgroundClip: 'text',
                                                                WebkitTextFillColor: 'transparent',
                                                                whiteSpace: 'pre-wrap',
                                                                wordBreak: 'break-word',
                                                                minHeight: '1.4em',
                                                                opacity: value ? 1 : 0.5,
                                                                display: 'block'
                                                            }}
                                                        />
                                                    )}
                                                />
                                            </Heading>
                                        </Box>
                                        {!profile.user_id && (
                                            <Badge size="1" variant="soft" color="gray">
                                                Shadow
                                            </Badge>
                                        )}
                                    </Flex>
                                </Flex>
                                <Flex direction="column" gap="2">
                                    <Controller
                                        name="headline"
                                        control={control}
                                        render={({ field: { value, ...field } }) => (
                                            <input
                                                {...field}
                                                value={value || ''}
                                                placeholder="Professional Headline"
                                                style={{
                                                    width: '100%',
                                                    background: 'none',
                                                    border: 'none',
                                                    outline: 'none',
                                                    padding: 0,
                                                    margin: 0,
                                                    fontSize: 'inherit',
                                                    lineHeight: 'inherit',
                                                    fontWeight: 'medium',
                                                    color: 'var(--gray-11)'
                                                }}
                                            />
                                        )}
                                    />
                                    {profile.summary !== undefined && (
                                        <Controller
                                            name="summary"
                                            control={control}
                                            render={({ field: { value, ...field } }) => (
                                                <textarea
                                                    {...field}
                                                    value={value || ''}
                                                    placeholder="Write a brief summary about yourself"
                                                    style={{
                                                        width: '100%',
                                                        background: 'none',
                                                        border: 'none',
                                                        outline: 'none',
                                                        padding: 0,
                                                        margin: 0,
                                                        fontSize: 'var(--font-size-2)',
                                                        lineHeight: '1.6',
                                                        fontWeight: 'inherit',
                                                        color: 'var(--gray-11)',
                                                        resize: 'vertical',
                                                        minHeight: '40px'
                                                    }}
                                                />
                                            )}
                                        />
                                    )}
                                </Flex>
                            </Box>
                        </Flex>
                    </Card>

                    <Card size="2">
                        <Box p="5">
                            <Flex justify="between" align="center" mb="4">
                                <Box style={{ flex: 1 }}>
                                    <Heading size="4">Experience</Heading>
                                </Box>
                                <IconButton
                                    type="button"
                                    variant="solid"
                                    size="1"
                                    onClick={() => appendPosition({
                                        title: '',
                                        company_name: '',
                                        started_on: '',
                                        finished_on: '',
                                        description: ''
                                    })}
                                >
                                    +
                                </IconButton>
                            </Flex>
                            <Flex direction="column" gap="4">
                                {positionFields.map((field, index) => (
                                    <Box key={field.id}>
                                        <Flex justify="between" align="center">
                                            <Box style={{ flex: 1 }}>
                                                <Text as="div" size="2" weight="bold">
                                                    <Controller
                                                        name={`positions.${index}.title`}
                                                        control={control}
                                                        render={({ field: { value, ...field } }) => (
                                                            <input
                                                                {...field}
                                                                value={value || ''}
                                                                placeholder="Title"
                                                                style={{
                                                                    width: '100%',
                                                                    background: 'none',
                                                                    border: 'none',
                                                                    outline: 'none',
                                                                    padding: 0,
                                                                    margin: 0,
                                                                    fontSize: 'inherit',
                                                                    lineHeight: 'inherit',
                                                                    fontWeight: 'inherit',
                                                                    color: 'inherit'
                                                                }}
                                                            />
                                                        )}
                                                    />
                                                </Text>
                                                <Text as="div" size="2" color="gray">
                                                    <Controller
                                                        name={`positions.${index}.company_name`}
                                                        control={control}
                                                        render={({ field: { value, ...field } }) => (
                                                            <input
                                                                {...field}
                                                                value={value || ''}
                                                                placeholder="Company"
                                                                style={{
                                                                    width: '100%',
                                                                    background: 'none',
                                                                    border: 'none',
                                                                    outline: 'none',
                                                                    padding: 0,
                                                                    margin: 0,
                                                                    fontSize: 'inherit',
                                                                    lineHeight: 'inherit',
                                                                    fontWeight: 'inherit',
                                                                    color: 'inherit'
                                                                }}
                                                            />
                                                        )}
                                                    />
                                                </Text>
                                                <Text as="div" size="2" color="gray">
                                                    <Flex gap="2">
                                                        <Controller
                                                            name={`positions.${index}.started_on`}
                                                            control={control}
                                                            render={({ field: { value, ...field } }) => (
                                                                <input
                                                                    {...field}
                                                                    type="date"
                                                                    value={value || ''}
                                                                    style={{
                                                                        background: 'none',
                                                                        border: 'none',
                                                                        outline: 'none',
                                                                        padding: 0,
                                                                        margin: 0,
                                                                        fontSize: 'inherit',
                                                                        lineHeight: 'inherit',
                                                                        fontWeight: 'inherit',
                                                                        color: 'var(--gray-11)',
                                                                        width: '130px',
                                                                        opacity: 1,
                                                                        WebkitTextFillColor: 'var(--gray-11)'
                                                                    }}
                                                                />
                                                            )}
                                                        />
                                                        {' - '}
                                                        <Controller
                                                            name={`positions.${index}.finished_on`}
                                                            control={control}
                                                            render={({ field: { value, ...field } }) => (
                                                                <input
                                                                    {...field}
                                                                    type="date"
                                                                    value={value || ''}
                                                                    style={{
                                                                        background: 'none',
                                                                        border: 'none',
                                                                        outline: 'none',
                                                                        padding: 0,
                                                                        margin: 0,
                                                                        fontSize: 'inherit',
                                                                        lineHeight: 'inherit',
                                                                        fontWeight: 'inherit',
                                                                        color: 'var(--gray-11)',
                                                                        width: '130px',
                                                                        opacity: 1,
                                                                        WebkitTextFillColor: 'var(--gray-11)'
                                                                    }}
                                                                />
                                                            )}
                                                        />
                                                    </Flex>
                                                </Text>
                                                <Text as="div" size="2" color="gray">
                                                    <Controller
                                                        name={`positions.${index}.description`}
                                                        control={control}
                                                        render={({ field: { value, ...field } }) => (
                                                            <textarea
                                                                {...field}
                                                                value={value || ''}
                                                                placeholder="Description"
                                                                style={{
                                                                    width: '100%',
                                                                    background: 'none',
                                                                    border: 'none',
                                                                    outline: 'none',
                                                                    padding: 0,
                                                                    margin: 0,
                                                                    fontSize: 'inherit',
                                                                    lineHeight: 'inherit',
                                                                    fontWeight: 'inherit',
                                                                    color: 'inherit',
                                                                    resize: 'vertical',
                                                                    minHeight: '60px'
                                                                }}
                                                            />
                                                        )}
                                                    />
                                                </Text>
                                            </Box>
                                            <IconButton
                                                type="button"
                                                variant="ghost"
                                                size="1"
                                                color="red"
                                                onClick={() => removePosition(index)}
                                                style={{ marginRight: '3px' }}
                                            >
                                                <Cross2Icon width="15" height="15" />
                                            </IconButton>
                                        </Flex>
                                        {index < positionFields.length - 1 && (
                                            <Separator size="4" my="3" />
                                        )}
                                    </Box>
                                ))}
                                {positionFields.length === 0 && (
                                    <Text size="2" color="gray" align="center">
                                        No experience added yet. Click &quot;+&quot; to add your work history.
                                    </Text>
                                )}
                            </Flex>
                        </Box>
                    </Card>

                    <Card size="2">
                        <Box p="5">
                            <Flex justify="between" align="center" mb="4">
                                <Box style={{ flex: 1 }}>
                                    <Heading size="4">Education</Heading>
                                </Box>
                                <IconButton
                                    type="button"
                                    variant="solid"
                                    size="1"
                                    onClick={() => appendEducation({
                                        degree_name: '',
                                        institution_name: '',
                                        started_on: '',
                                        finished_on: ''
                                    })}
                                >
                                    +
                                </IconButton>
                            </Flex>
                            <Flex direction="column" gap="4">
                                {educationFields.map((field, index) => (
                                    <Box key={field.id}>
                                        <Flex justify="between" align="center">
                                            <Box style={{ flex: 1 }}>
                                                <Text as="div" size="2" weight="bold">
                                                    <Controller
                                                        name={`education.${index}.degree_name`}
                                                        control={control}
                                                        render={({ field: { value, ...field } }) => (
                                                            <input
                                                                {...field}
                                                                value={value || ''}
                                                                placeholder="Degree"
                                                                style={{
                                                                    width: '100%',
                                                                    background: 'none',
                                                                    border: 'none',
                                                                    outline: 'none',
                                                                    padding: 0,
                                                                    margin: 0,
                                                                    fontSize: 'inherit',
                                                                    lineHeight: 'inherit',
                                                                    fontWeight: 'inherit',
                                                                    color: 'inherit'
                                                                }}
                                                            />
                                                        )}
                                                    />
                                                </Text>
                                                <Text as="div" size="2" color="gray">
                                                    <Controller
                                                        name={`education.${index}.institution_name`}
                                                        control={control}
                                                        render={({ field: { value, ...field } }) => (
                                                            <input
                                                                {...field}
                                                                value={value || ''}
                                                                placeholder="Institution"
                                                                style={{
                                                                    width: '100%',
                                                                    background: 'none',
                                                                    border: 'none',
                                                                    outline: 'none',
                                                                    padding: 0,
                                                                    margin: 0,
                                                                    fontSize: 'inherit',
                                                                    lineHeight: 'inherit',
                                                                    fontWeight: 'inherit',
                                                                    color: 'inherit'
                                                                }}
                                                            />
                                                        )}
                                                    />
                                                </Text>
                                                <Text as="div" size="2" color="gray">
                                                    <Flex gap="2">
                                                        <Controller
                                                            name={`education.${index}.started_on`}
                                                            control={control}
                                                            render={({ field: { value, ...field } }) => (
                                                                <input
                                                                    {...field}
                                                                    type="date"
                                                                    value={value || ''}
                                                                    style={{
                                                                        background: 'none',
                                                                        border: 'none',
                                                                        outline: 'none',
                                                                        padding: 0,
                                                                        margin: 0,
                                                                        fontSize: 'inherit',
                                                                        lineHeight: 'inherit',
                                                                        fontWeight: 'inherit',
                                                                        color: 'var(--gray-11)',
                                                                        width: '130px',
                                                                        opacity: 1,
                                                                        WebkitTextFillColor: 'var(--gray-11)'
                                                                    }}
                                                                />
                                                            )}
                                                        />
                                                        {' - '}
                                                        <Controller
                                                            name={`education.${index}.finished_on`}
                                                            control={control}
                                                            render={({ field: { value, ...field } }) => (
                                                                <input
                                                                    {...field}
                                                                    type="date"
                                                                    value={value || ''}
                                                                    style={{
                                                                        background: 'none',
                                                                        border: 'none',
                                                                        outline: 'none',
                                                                        padding: 0,
                                                                        margin: 0,
                                                                        fontSize: 'inherit',
                                                                        lineHeight: 'inherit',
                                                                        fontWeight: 'inherit',
                                                                        color: 'var(--gray-11)',
                                                                        width: '130px',
                                                                        opacity: 1,
                                                                        WebkitTextFillColor: 'var(--gray-11)'
                                                                    }}
                                                                />
                                                            )}
                                                        />
                                                    </Flex>
                                                </Text>
                                            </Box>
                                            <IconButton
                                                type="button"
                                                variant="ghost"
                                                size="1"
                                                color="red"
                                                onClick={() => removeEducation(index)}
                                                style={{ marginRight: '2px' }}
                                            >
                                                <Cross2Icon width="15" height="15" />
                                            </IconButton>
                                        </Flex>
                                        {index < educationFields.length - 1 && (
                                            <Separator size="4" my="3" />
                                        )}
                                    </Box>
                                ))}
                                {educationFields.length === 0 && (
                                    <Text size="2" color="gray" align="center">
                                        No education added yet. Click &quot;+&quot; to add your educational background.
                                    </Text>
                                )}
                            </Flex>
                        </Box>
                    </Card>

                    <Card size="2">
                        <Box p="5">
                            <Heading size="4" mb="4">Skills</Heading>
                            <Flex gap="2" wrap="wrap">
                                {skillFields.map((field, index) => (
                                    <Flex key={field.id} align="center" gap="1">
                                        <Badge variant="soft">
                                            <Controller
                                                name={`skills.${index}.name`}
                                                control={control}
                                                render={({ field: { value, ...field } }) => (
                                                    <input
                                                        {...field}
                                                        value={value || ''}
                                                        style={{
                                                            width: value ? `${value.length}ch` : '9ch',
                                                            background: 'none',
                                                            border: 'none',
                                                            outline: 'none',
                                                            padding: 0,
                                                            margin: 0,
                                                            fontSize: 'inherit',
                                                            lineHeight: 'inherit'
                                                        }}
                                                    />
                                                )}
                                            />
                                        </Badge>
                                        <IconButton
                                            type="button"
                                            variant="ghost"
                                            size="1"
                                            color="red"
                                            onClick={() => removeSkill(index)}
                                        >
                                            <Cross2Icon width="15" height="15" />
                                        </IconButton>
                                    </Flex>
                                ))}
                                <Flex align="center" gap="1">
                                    <Badge variant="soft">
                                        <Controller
                                            name="newSkill"
                                            control={control}
                                            render={({ field: { value, ...field } }) => (
                                                <input
                                                    {...field}
                                                    placeholder="Add skill"
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            e.preventDefault();
                                                            const value = e.currentTarget.value.trim();
                                                            if (value) {
                                                                appendSkill({ name: value });
                                                                e.currentTarget.value = '';
                                                            }
                                                        }
                                                    }}
                                                    style={{
                                                        width: value ? `${value.length}ch` : `${("Add skill").length}ch`,
                                                        background: 'none',
                                                        border: 'none',
                                                        outline: 'none',
                                                        padding: 0,
                                                        margin: 0,
                                                        fontSize: 'inherit',
                                                        lineHeight: 'inherit'
                                                    }}
                                                />
                                            )}
                                        />
                                    </Badge>
                                    <IconButton
                                        type="button"
                                        variant="solid"
                                        size="1"
                                        onClick={() => {
                                            const input = document.querySelector('input[placeholder="Add skill"]') as HTMLInputElement;
                                            const value = input?.value.trim();
                                            if (value) {
                                                appendSkill({ name: value });
                                                input.value = '';
                                            }
                                        }}
                                        disabled={isLoading}
                                    >
                                        +
                                    </IconButton>
                                </Flex>
                                {skillFields.length === 0 && (
                                    <Text size="2" color="gray">
                                        No skills added yet. Type a skill and press Enter or click &quot;+&quot; to add your skills.
                                    </Text>
                                )}
                            </Flex>
                        </Box>
                    </Card>
                </Flex>
            </form>
        </Box>
    )
} 
