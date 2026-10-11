import React from 'react'
import { Form, Input, Space } from 'antd'
import SwitchLabel from '../../common/switch'
import HelpIcon from '../../common/help-icon'
import { formItemLayout } from '../../../common/form-layout'

const FormItem = Form.Item
const e = window.translate

export default function SshAgent () {
  return (
    <>
      <FormItem
        {...formItemLayout}
        label={e('useSshAgent')}
      >
        <Space align='center'>
          <FormItem
            name='useSshAgent'
            valuePropName='checked'
            noStyle
          >
            <SwitchLabel />
          </FormItem>
          <FormItem
            name='sshAgent'
            noStyle
          >
            <Input placeholder={e('SSH Agent Path')} />
          </FormItem>
          <HelpIcon link='https://github.com/electerm/electerm/wiki/ssh-agent' />
        </Space>
      </FormItem>
      <FormItem
        {...formItemLayout}
        label={e('agentForward')}
        name='agentForward'
        valuePropName='checked'
      >
        <SwitchLabel />
      </FormItem>
      <FormItem
        {...formItemLayout}
        label='Warpgate'
        name='warpgateCompat'
        valuePropName='checked'
        tooltip='Enable Warpgate compatibility: forward the SSH agent without waiting for acknowledgement and start SFTP after selecting a target in the SSH menu.'
      >
        <SwitchLabel />
      </FormItem>
    </>
  )
}
